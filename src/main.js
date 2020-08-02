const winston = require("winston");

// src
const Candidate = require("./candidate");
const Database = require("./database");
// src.network.web
const Tickers = require("./network/web/coinbase/ticker");
// src.network.webthree
const FlashLiquidator = require("./network/webthree/goldenage/flashliquidator");
const Tokens = require("./network/webthree/compound/ctoken");

class Main extends Database {
  constructor(
    gasPriceMultiplier,
    minRevenue,
    maxRevenue,
    maxHealth,
    numCandidates
  ) {
    /**
     * Constructs a `Main` object
     *
     * @param {number} gasPriceMultiplier When sending transactions, use
     *    market-recommended gas price multiplied by this amount
     * @param {number} minRevenue Any user with potential revenue less
     *    than this number will be excluded when choosing candidates
     * @param {number} maxRevenue Any user with potential revenue greater
     *    than this number will be excluded when choosing candidates
     * @param {number} maxHealth Any user with a health greater than this
     *    number will be excluded when choosing candidates
     * @param {number} numCandidates Users are ranked by liquidity
     *    (lowest to highest). This specifies how many candidates
     *    should be taken from the top of that list
     *
     */
    super();

    this._gasPriceMultiplier = gasPriceMultiplier;
    this._minRevenue = minRevenue;
    this._maxRevenue = maxRevenue;
    this._maxHealth = maxHealth;
    this._numCandidates = Math.floor(numCandidates);

    this._candidates = [];
    this._prepared_tx_data = {};
  }

  async getGasPrice_Gwei() {
    const market_Gwei = Number(await web3.eth.getGasPrice()) / 1e9;
    return market_Gwei * this._gasPriceMultiplier;
  }

  async getTxFee_Eth(gas = 2000000, gasPrice = null) {
    if (gasPrice === null) gasPrice = await this.getGasPrice_Gwei();
    return (gasPrice * gas) / 1e9;
  }

  async updateCandidates() {
    this._candidates = (
      await this._tUsers.getLiquidationCandidates(
        this._numCandidates,
        this._minRevenue,
        this._maxRevenue,
        this._maxHealth
      )
    ).map(c => new Candidate(c));
  }

  async onNewBlock(blockNumber) {
    const gasPrice_Gwei = await this.getGasPrice_Gwei();
    const estTxFee_Eth = await this.getTxFee_Eth(undefined, gasPrice_Gwei);
    const ethPrice_USD =
      1.0 / (await Tokens.mainnet.cUSDC.priceInEth()).toFixed(8);

    for (let i of this._candidates) {
      // this is pairID DAI and SAI. There's no AAVE pool for it.
      if (i.ctokenidpay == 2 || (i.ctokenidpay == 6 && i.ctokenidseize == 2))
        continue;

      // retrieve addresses for pre-computed best repay and seize tokens
      const repay = `0x${await this._tCTokens.getAddress(i.ctokenidpay)}`;
      const seize = `0x${await this._tCTokens.getAddress(i.ctokenidseize)}`;

      // liquidatable on-chain
      if (await i.isLiquidatable()) {
        // estimate profit and log it
        const profit = ethPrice_USD * (i.profitability - estTxFee_Eth);
        if (profit < 0) continue;
        winston.log(
          "info",
          `🐳 *Proposal ${i.label}* | Liquidating for $${profit.toFixed(
            2
          )} profit at block ${blockNumber}`
        );
        // create transaction
        const tx = FlashLiquidator.mainnet.liquidateMany(
          [i.address],
          [repay],
          [seize],
          gasPrice_Gwei
        );
        // send to TxManager worker
        process.send({
          tx: tx,
          priority: profit,
          key: i.address
        });
      }
      // liquidatable off-chain
      else if ((await i.liquidityOffChain(Tickers.mainnet)) < 0.0) {
        const profit = ethPrice_USD * (i.profitability - estTxFee_Eth);
        if (profit < 0) continue;

        if (!(i.address in this._prepared_tx_data))
          winston.log(
            "info",
            `🌊 *Price Wave* | Added ${i.label} for $${profit.toFixed(
              2
            )} profit if prices get posted`
          );

        this._prepared_tx_data[i.address] = {
          repayCToken: repay,
          seizeCToken: seize
        };
      }
    }

    Tickers.mainnet.update();
  }

  onNewPricesOnChain(oracleTx) {
    let borrowers = [];
    let repayCTokens = [];
    let seizeCTokens = [];
    for (let address in this._prepared_tx_data) {
      borrowers.push(address);
      repayCTokens.push(this._prepared_tx_data[address].repayCToken);
      seizeCTokens.push(this._prepared_tx_data[address].seizeCToken);
    }
    this._prepared_tx_data = {};
    if (borrowers.length === 0) return;

    winston.log(
      "info",
      `🏷 *Prices Posted* | ${borrowers.length} item(s) in wave queue`
    );

    const txA = FlashLiquidator.mainnet.liquidateMany(
      borrowers,
      repayCTokens,
      seizeCTokens,
      oracleTx.gasPrice / 1e12
    );
    const txB = FlashLiquidator.mainnet.liquidateMany(
      borrowers,
      repayCTokens,
      seizeCTokens,
      (oracleTx.gasPrice + 100) / 1e12
    );

    process.send({
      tx: txB,
      priority: 1001,
      key: borrowers[1]
    });
    process.send({
      tx: txA,
      priority: 1000,
      key: borrowers[0]
    });
  }

  onNewLiquidation(event, logNonCandidates = false) {
    if (event.liquidator == FlashLiquidator.mainnet.address) return;
    const addr = event.borrower;
    delete this._prepared_tx_data[addr.toLowerCase()];

    if (!this._candidates.includes(addr.toLowerCase())) {
      if (logNonCandidates) {
        winston.log(
          "info",
          `⤼ *Liquidate Event* | Didn't liquidate ${addr.slice(
            0,
            6
          )} because they weren't a candidate.`
        );
      }
    } else {
      winston.log(
        "warn",
        `🚨 *Liquidate Event* | Didn't liquidate ${addr.slice(
          0,
          6
        )} due to bad logic (or gas war).`
      );
    }
  }
}

module.exports = Main;
