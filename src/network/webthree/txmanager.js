const Tx = require("ethereumjs-tx").Transaction;
const winston = require("winston");

class TxManager {
  constructor(envKeyAddress, envKeySecret, maxInProgressTxs = 5) {
    this._envKeyAddress = envKeyAddress;
    this._envKeySecret = envKeySecret;

    this._maxInProgressTxs = maxInProgressTxs;
    this._numInProgressTxs = 0;

    this._nextNonce = null;
    this._queue = [];
    this._gasPrices = {};
  }

  async init() {
    if (this._nextNonce !== null) {
      console.error("Already initialized TxManager. Aborting");
      return;
    }

    this._nextNonce = await web3.eth.getTransactionCount(
      process.env[this._envKeyAddress]
    );

    // TODO web3 returns empty tx array, even before filtering
    // (await TxManager._getPendingTxsFrom(process.env[this._envKeyAddress]))
    //   .sort((a, b) => a.nonce - b.nonce)
    //   .forEach(tx => {
    //     this.insert({
    //       to: tx.to,
    //       gas: tx.gas,
    //       gasPrice: tx.gasPrice,
    //       data: tx.input,
    //       value: tx.value
    //     });
    //   });
  }

  insert(
    tx,
    priority = 0,
    timeout = 60 * 1000,
    rejectIfDuplicate = false,
    key = null
  ) {
    /**
     * Adds a new transaction to the wallet's queue (even if it's a duplicate)
     *
     * @param {object} tx The transaction object {to, gas, gasPrice, data, value}
     * @param {number} priority Sorting criteria. Higher priority txs go first
     * @param {number} timeout Time (in milliseconds) after which tx slot will be freed;
     *    if queue contains other txs, they will override this one
     * @param {boolean} rejectIfDuplicate Ignores the input tx if its "to" and "key" fields
     *    are the same as a transaction in the current queue
     * @param {string} key If two txs have the same key, they will be considered duplicates
     *
     */
    if (rejectIfDuplicate) {
      if (
        this._queue.filter(item => item.tx.to === tx.to && item.key === key)
          .length > 0
      ) {
        winston.log("warn", "💸 *Transaction* | Skipped duplicate");
        return;
      }
    }

    // add tx to queue
    this._queue.push({
      id: null,
      tx: tx,
      priority: priority,
      inProgress: false,
      timeout: timeout,
      key: key
    });
    // if the priority is nonzero, sort queue
    if (priority) this._queue.sort((a, b) => b.priority - a.priority);

    this._maximizeNumInProgressTxs();
  }

  _maximizeNumInProgressTxs() {
    for (let i = 0; i < this._queue.length; i++) {
      if (this._numInProgressTxs === this._maxInProgressTxs) break;

      if (!this._queue[i].inProgress) {
        // set tx nonce
        this._queue[i].inProgress = true;
        this._queue[i].id = this._nextNonce;
        this._nextNonce++;
        // send tx and setup its callback events
        const sentTx = this._signAndSend(this._queue[i].tx, this._queue[i].id);
        const handle = setInterval(
          this._onTxErrorFor.bind(this),
          this._queue[i].timeout,
          this._queue[i].id
        );
        this._setupTxEvents(sentTx, this._queue[i].id, handle);
        // now that tx is in progress, update state
        this._numInProgressTxs++;
      }
    }
  }

  _setupTxEvents(sentTx, nonce, setIntervalHandle) {
    const label = `💸 *Transaction* | ${
      String(process.env[this._envKeyAddress]).slice(0, 6)
    }.${nonce} `;

    sentTx.on("transactionHash", hash => {
      winston.log(
        "info",
        label + `Available on <https://etherscan.io/tx/${hash}|etherscan>`
      );
    });
    sentTx.on("receipt", receipt => {
      clearInterval(setIntervalHandle);
      winston.log("info", label + "Successful!");
      this._onTxReceiptFor(nonce);
    });
    sentTx.on("error", (err, receipt) => {
      clearInterval(setIntervalHandle);
      if (receipt !== undefined) {
        winston.log("info", label + "Failed on-chain: " + String(err));
        this._onTxReceiptFor(nonce);
        return;
      }
      winston.log("error", label + "Failed off-chain: " + String(err));
      this._onTxErrorFor(nonce);
    });
  }

  _onTxReceiptFor(nonce) {
    delete this._gasPrices[nonce];
    this._queue = this._queue.filter(tx => tx.id !== nonce);
    this._numInProgressTxs--;
    this._maximizeNumInProgressTxs();
  }

  _onTxErrorFor(nonce) {
    const queueOld = [...this._queue];
    this._queue = [];

    for (let item of queueOld) {
      if (item.id !== nonce) {
        item.id = null;
        item.inProgress = false;
        this._queue.push(item);
      }
    }

    this._nextNonce = nonce;
    this._numInProgressTxs = 0;
    this._maximizeNumInProgressTxs();
  }

  // _emptyTx(gasPrice) {
  //   return {
  //     to: process.env[this._envKeyAddress],
  //     gas: 21000,
  //     gasPrice: gasPrice,
  //     value: 0
  //   };
  // }

  _signAndSend(tx, nonce) {
    tx.gasPrice = Number(tx.gasPrice);
    if (nonce in this._gasPrices)
      tx.gasPrice = Math.max(tx.gasPrice, this._gasPrices[nonce] + 100);
    this._gasPrices[nonce] = tx.gasPrice;

    tx.nonce = web3.utils.toHex(nonce);
    tx.from = process.env[this._envKeyAddress];
    tx.gasPrice = web3.utils.toHex(Math.floor(tx.gasPrice));
    return TxManager._send(this._sign(tx));
  }

  _sign(tx) {
    tx = new Tx(tx); // Could add chain/hardfork specifics here
    tx.sign(Buffer.from(process.env[this._envKeySecret], "hex"));
    return "0x" + tx.serialize().toString("hex");
  }

  static _send(signedTx) {
    return web3.eth.sendSignedTransaction(signedTx);
  }

  static async _getPendingTxsFrom(address) {
    return (await web3.eth.getPendingTransactions()).filter(
      tx => tx.from === address
    );
  }
}

module.exports = TxManager;