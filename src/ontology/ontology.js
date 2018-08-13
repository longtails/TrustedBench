'use strict';

const BlockchainInterface = require('../comm/blockchain-interface.js');
const TxStatus = require('../comm/transaction');
const Util = require('../comm/util.js');
const log = Util.log;
const NetUtil = require('./net_util.js');
const fs = require('fs');
const ontSdk = require('ontology-ts-sdk');

/**
 * Implements {BlockchainInterface} for a Fabric backend.
 */
class Ontology extends BlockchainInterface {
    /**
     * Create a new instance of the {Fabric} class.
     * @param {string} config_path The path of the Fabric network configuration file.
     */
    constructor(config_path) {
        super(config_path);
        let fileContent = fs.readFileSync(this.configPath, 'utf-8');
        let jsonInfo = JSON.parse(fileContent);
        let blockChainConfig = JSON.parse(fs.readFileSync(jsonInfo.blockchain.config, 'utf-8'));
        this.contractConfig = blockChainConfig.ontology.contract;
        let walletFileContent = fs.readFileSync(blockChainConfig.ontology.wallet, 'utf-8');
        this.wallet = ontSdk.Wallet.parseJson(walletFileContent);
        this.account = this.wallet.accounts[0];
        try {
            const saltHex = Buffer.from(this.account.salt, 'base64').toString('hex');
            const encryptedPrivateKeyObj = new ontSdk.Crypto.PrivateKey(this.account.encryptedKey.key);
            let decryptParam = {
                cost: this.wallet.scrypt.n,
                blockSize: this.wallet.scrypt.r,
                parallel: this.wallet.scrypt.p,
                size: this.wallet.scrypt.dkLen
            };
            this.privateKey = encryptedPrivateKeyObj.decrypt(blockChainConfig.ontology.password,
                this.account.address, saltHex, decryptParam);
        } catch (err) {
            throw Error('decrypt wallet failed');
        }
        this.contractAbiInfo = new Map();
    }

    /**
     * ontology no need init
     * @return {Promise} The return promise.
     */
    init() {
        return Promise.resolve();
    }

    /**
     * ontology no need install smart contract
     * @return {Promise} The return promise.
     */
    async installSmartContract() {
        this.contractConfig.forEach((item, index) => {
            let name = item.name;
            let codeVersion = item.version;
            let author = item.author;
            let email = item.email;
            let desp = item.description;
            let needStorage = item.needStorage;
            let vmCode = fs.readFileSync(item.path, 'utf-8');
            let tx = ontSdk.TransactionBuilder.makeDeployCodeTransaction(vmCode, name, codeVersion, author, email, desp,
                needStorage, '0', '20000000', this.account.address);
            ontSdk.TransactionBuilder.signTransaction(tx, this.privateKey);
            NetUtil.postTx(tx.serialize());
            // read abi info
            let abiFileContent = fs.readFileSync(item.abi, 'utf-8');
            let abiInfo = ontSdk.AbiInfo.parseJson(abiFileContent);
            abiInfo.vmCode = vmCode;
            this.contractAbiInfo.set(name, abiInfo);
            let txHash = ontSdk.utils.reverseHex(tx.getHash())
            log('deploy', txHash);
        });
        await this.waitABlock();
        return Promise.resolve();
    }

    /**
     * ontology no need context
     * @param {string} name The name of the callback module as defined in the configuration files.
     * @param {object} args Unused.
     * @return {object} The assembled Fabric context.
     */
    getContext(name, args) {
        return Promise.resolve();
    }

    /**
     * ontology no need context
     * @param {object} context The Fabric context to release.
     * @return {Promise} The return promise.
     */
    releaseContext(context) {
        return Promise.resolve();
    }

    /**
     * transfer ont or ong
     * @param {string} txHash transaction data
     * @param {string} txData transaction hash
     * @return {TxStatus}The txStatus for the transaction
     */
    transfer(txHash, txData) {
        let invokeStatus = new TxStatus(txHash);
        return NetUtil.postTx(txData).then((result) => {
            if (result < 0) {
                invokeStatus.SetStatusFail();
                log('tx %s failed', result.GetID());
            }
            log('sendtx');
            return invokeStatus;
        });
    }

    /**
     * Invoke smart contract/submit transactions
     * @param {Object} context context object
     * @param {String} contractID contract name
     * @param {String} contractVer version of the contract
     * @param {Array} args array of JSON formatted arguments for multiple transactions
     * @param {Number} timeout request timeout, in second
     * @return {Promise} txStatus object or an array of txStatus objects
     */
    invokeSmartContract(context, contractID, contractVer, args, timeout) {
        let abiInfo = this.contractAbiInfo.get(contractID);
        if (typeof abiInfo === 'undefined') {
            throw new Error('the contract doesn\'t deploy!');
        }
        let abiFunc = abiInfo.getFunction(args.func);
        if (!args.hasOwnProperty('func') || typeof abiFunc === 'undefined') {
            throw new Error('not define invoke contract func!');
        }
        for (let i = 0; i < abiFunc.parameters.length; i++) {
            let param = new ontSdk.Parameter(abiFunc.parameters[i].getName(), abiFunc.parameters[i].getType(),
                args.args[i]);
            abiFunc.setParamsValue(param);
        }
        let tx = ontSdk.TransactionBuilder.makeInvokeTransaction(abiFunc.name, abiFunc.parameters,
            ontSdk.Crypto.Address.fromVmCode(abiInfo.vmCode), '0', '20000000', this.account.address);
        ontSdk.TransactionBuilder.signTransaction(tx, this.privateKey);
        let txHash = ontSdk.utils.reverseHex(tx.getHash())
        let invokeStatus = new TxStatus(txHash);
        log('invoke', txHash);
        return NetUtil.postTx(tx.serialize()).then((result) => {
            if (result < 0) {
                invokeStatus.SetStatusFail();
                log('tx %s failed', result.GetID());
            }
            log('sendtx');
            return invokeStatus;
        });
    }

    /**
     * get current height
     * @return {int} current height
     */
    async getHeight() {
        return await NetUtil.getHeight();
    }

    /**
     * get current height
     * @param {int} height block height
     * @return {string[]} all tx hashes in the block
     */
    async getBlockTxHashes(height) {
        return await NetUtil.getTxNumOfHeight(height);
    }

    /**
     * insure tx
     * @param {string} txHash tx hash
     * @return {Promise} tx is success or failed
     */
    async insureTx(txHash) {
        return await NetUtil.insureTx(txHash);
    }

    /**
     * wait a block generate
     */
    async waitABlock() {
        let currnetHeight = await this.getHeight();
        let newHeight = currnetHeight;
        do {
            newHeight = await this.getHeight();
            if (newHeight > currnetHeight) {
                break;
            } else {
                await Util.sleep(1000).then(() => {
                });
            }
        } while (newHeight <= currnetHeight);
    }
}

module.exports = Ontology;