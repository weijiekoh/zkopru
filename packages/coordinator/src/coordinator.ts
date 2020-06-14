import { Field } from '@zkopru/babyjubjub'
import express, { RequestHandler } from 'express'
import { scheduleJob, Job } from 'node-schedule'
import { EventEmitter } from 'events'
import { ZkTx } from '@zkopru/transaction'
import { Item } from '@zkopru/tree'
import { logger, root, bnToBytes32, bnToUint256 } from '@zkopru/utils'
import {
  FullNode,
  BootstrapData,
  NetworkStatus,
  Header,
  Body,
  MassMigration,
  massMigrationHash,
  massDepositHash,
  MassDeposit,
  serializeBody,
  serializeHeader,
  headerHash,
} from '@zkopru/core'
import { Account } from 'web3-core'
import { Subscription } from 'web3-core-subscriptions'
import { MassDeposit as MassDepositSql } from '@zkopru/prisma'
import { Server } from 'http'
import chalk from 'chalk'
import { Address, Bytes32, Uint256 } from 'soltypes'
import { TxMemPool, TxPoolInterface } from './tx_pool'

export interface CoordinatorConfig {
  maxBytes: number
  bootstrap: boolean
  port: number
  priceMultiplier: number // gas per byte is 16, our default value is 32
}

export interface CoordinatorInterface {
  start: () => void
  onTxRequest(handler: (tx: ZkTx) => Promise<string>): void
  onBlock: () => void
}

export class Coordinator extends EventEmitter {
  node: FullNode

  api?: Server

  bootstrapCache: {
    [hash: string]: BootstrapData
  }

  account: Account

  gasPriceSubscriber?: Subscription<unknown>

  gasPrice?: Field

  txPool: TxPoolInterface

  config: CoordinatorConfig

  genBlockJob?: Job

  constructor(node: FullNode, account: Account, config: CoordinatorConfig) {
    super()
    this.account = account
    this.node = node
    this.txPool = new TxMemPool()
    this.config = { priceMultiplier: 32, ...config }
    this.bootstrapCache = {}
  }

  start() {
    logger.info('Coordinator started')
    this.node.startSync()
    this.startAPI()
    this.startSubscribeGasPrice()
    this.node.on(
      'status',
      async (status: NetworkStatus, blockHash?: Bytes32) => {
        // udpate the txpool using the newly proposed hash
        // if the hash does not exist in the tx pool's block list
        // create an observer to fetch the block data from database
        switch (status) {
          case NetworkStatus.SYNCED:
          case NetworkStatus.FULLY_SYNCED:
            // It tries to propose a block until any block is proposed to the layer1
            if (blockHash) {
              const block = await this.node.l2Chain.getBlock(blockHash)
              if (block) {
                this.txPool.markAsIncluded(block.body.txs)
              }
            }
            this.startGenBlock()
            break
          default:
            this.stopGenBlock()
            // cancel proposal
            break
        }
      },
    )
    this.emit('start')
  }

  async stop(): Promise<void> {
    return new Promise(res => {
      this.node.on('status', status => {
        if (status === NetworkStatus.STOPPED) {
          this.emit('stop')
          res()
        }
      })
      if (this.api) {
        this.api.close(() => {
          if (this.node.status === NetworkStatus.STOPPED) {
            res()
          } else {
            this.node.stopSync()
          }
        })
      } else if (this.node.status === NetworkStatus.STOPPED) {
        res()
      } else {
        this.node.stopSync()
      }
    })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async registerVk(nIn: number, nOut: number, vk: any): Promise<any> {
    const tx = this.node.l1Contract.setup.methods.registerVk(
      nIn,
      nOut,
      vk.vk_alfa_1.slice(0, 2),
      vk.vk_beta_2.slice(0, 2),
      vk.vk_gamma_2.slice(0, 2),
      vk.vk_delta_2.slice(0, 2),
      vk.IC.map(arr => arr.slice(0, 2)),
    )
    return this.node.l1Contract.sendTx(tx, { from: this.account.address })
  }

  async completeSetup(): Promise<any> {
    const tx = this.node.l1Contract.setup.methods.completeSetup()
    return this.node.l1Contract.sendTx(tx, { from: this.account.address })
  }

  async commitMassDeposit(): Promise<any> {
    const tx = this.node.l1Contract.coordinator.methods.commitMassDeposit()
    return this.node.l1Contract.sendTx(tx, { from: this.account.address })
  }

  async registerAsCoordinator(): Promise<any> {
    const { minimumStake } = this.node.l2Chain.config
    const tx = this.node.l1Contract.coordinator.methods.register()
    return this.node.l1Contract.sendTx(tx, {
      value: minimumStake,
      from: this.account.address,
    })
    // return this.sendTx(tx)
  }

  async deregister(): Promise<any> {
    const tx = this.node.l1Contract.coordinator.methods.deregister()
    return this.node.l1Contract.sendTx(tx, { from: this.account.address })
  }

  private startAPI() {
    if (!this.api) {
      const app = express()
      app.use(express.text())
      app.post('/tx', this.txHandler)
      if (this.config.bootstrap) {
        app.get('/bootstrap', this.bootstrapHandler)
      }
      app.get('/price', this.bytePriceHandler)
      this.api = app.listen(this.config.port, () => {
        logger.info(
          `coordinator.js: API is running on apiPort ${this.config.port}`,
        )
      })
    }
  }

  private async startSubscribeGasPrice() {
    if (this.gasPriceSubscriber) return
    this.gasPrice = Field.from(
      await this.node.l1Contract.web3.eth.getGasPrice(),
    )
    this.gasPriceSubscriber = this.node.l1Contract.web3.eth.subscribe(
      'newBlockHeaders',
      async () => {
        this.gasPrice = Field.from(
          await this.node.l1Contract.web3.eth.getGasPrice(),
        )
      },
    )
  }

  private txHandler: RequestHandler = async (req, res) => {
    const txData = req.body
    logger.info(`tx data is${txData}`)
    logger.info(txData)
    const zkTx = ZkTx.decode(Buffer.from(txData, 'hex'))
    // const zkTx = ZkTx.decode(txData)
    const result = await this.node.verifier.snarkVerifier.verifyTx(zkTx)
    if (result) {
      await this.txPool.addToTxPool(zkTx)
      res.send(result)
    } else {
      logger.info('Coordinator is not running. Run start()')
      res.status(500).send('Coordinator is not running')
    }
  }

  private bootstrapHandler: RequestHandler = async (req, res) => {
    const { hash } = req.query
    logger.info(`bootstrap called for ${hash}`)
    let hashForBootstrapBlock: string
    if (typeof hash !== 'string') {
      logger.info('Api accepts only a single string obj')
      res.status(500).send('API accepts only a single string')
      return
    }
    if (hash) {
      hashForBootstrapBlock = hash
    } else {
      hashForBootstrapBlock = await this.node.l1Contract.upstream.methods
        .latest()
        .call()
    }
    if (this.bootstrapCache[hashForBootstrapBlock]) {
      res.send(this.bootstrapCache[hashForBootstrapBlock])
    }
    const blockHash = Bytes32.from(hashForBootstrapBlock)
    const block = await this.node.l2Chain.getBlock(blockHash)
    const proposal = await this.node.l2Chain.getProposal(blockHash)
    if (!proposal) {
      const message = `Failed to find a proposal for the requested  ${hash}`
      logger.info(message)
      res.status(500).send(message)
      return
    }
    if (!block) {
      const message = `Failed to find the requested block ${hash}`
      logger.info(message)
      res.status(500).send(message)
      return
    }
    if (!block.bootstrap) {
      const message = `Bootstrap for the requested block ${hash} does not exist`
      logger.info(message)
      res.status(500).send(message)
      return
    }
    res.send({
      proposalTx: proposal.proposalTx,
      blockHash: block.hash,
      utxoTreeIndex: block.bootstrap.utxoTreeIndex,
      utxoStartingLeafProof: {
        root: block.header.utxoRoot.toString(),
        index: block.header.utxoIndex.toString(),
        leaf: Field.zero.toHex(),
        siblings: block.bootstrap.utxoBootstrap.map(s => s.toString()),
      },
      withdrawalTreeIndex: block.bootstrap.withdrawalTreeIndex,
      withdrawalStartingLeafProof: {
        root: block.header.withdrawalRoot.toString(),
        index: block.header.withdrawalIndex.toString(),
        leaf: Field.zero,
        siblings: block.bootstrap.withdrawalBootstrap.map(s => s.toString()),
      },
    })
  }

  private bytePriceHandler: RequestHandler = async (_, res) => {
    const weiPerByte: string | undefined = this.gasPrice
      ?.muln(this.config.priceMultiplier)
      .toString(10)
    res.send({ weiPerByte })
  }

  private startGenBlock() {
    logger.info('Started to generate blocks')
    if (!this.genBlockJob)
      this.genBlockJob = scheduleJob('*/5 * * * * *', () =>
        this.proposeNewBlocks(),
      )
  }

  private stopGenBlock() {
    logger.info('Stopped to generate blocks')
    if (this.genBlockJob) this.genBlockJob.cancel()
    this.genBlockJob = undefined
  }

  private async proposeNewBlocks() {
    if (!this.gasPrice) {
      logger.info('Skip gen block. Gas price is not synced yet')
      return
    }
    logger.info('Generating block')
    let block: {
      header: Header
      body: Body
      fee: Field
    }
    try {
      block = await this.genBlock()
    } catch (err) {
      logger.error('Failed to gen block', err)
      return
    }
    const bytes = Buffer.concat([
      serializeHeader(block.header),
      serializeBody(block.body),
    ])
    const blockData = `0x${bytes.toString('hex')}`
    let expectedGas: number
    try {
      expectedGas = await this.node.l1Contract.coordinator.methods
        .propose(blockData)
        .estimateGas({
          from: this.account.address,
        })
    } catch (err) {
      logger.error(`Skip gen block. propose() fails`)
      logger.error(blockData)
      return
    }
    const expectedFee = this.gasPrice.muln(expectedGas)
    if (block.fee.lte(expectedFee)) {
      logger.info(
        `Skip gen block. Aggregated fee is not enough yet ${block.fee} / ${expectedFee}`,
      )
    } else {
      logger.info(
        chalk.green(`Proposed a new block: ${headerHash(block.header)}`),
      )
      await this.node.l1Contract.coordinator.methods.propose(blockData).send({
        from: this.account.address,
        gas: expectedGas,
        gasPrice: this.gasPrice.toString(),
      })
    }
  }

  private async genBlock(): Promise<{
    header: Header
    body: Body
    fee: Field
  }> {
    // TODO use node lock
    const deposits: Field[] = []
    let consumedBytes = 0
    let aggregatedFee: Field = Field.zero
    // 1. pick mass deposits
    const commits: MassDepositSql[] = await this.node.db.prisma.massDeposit.findMany(
      {
        where: {
          includedIn: null,
        },
      },
    )
    commits.sort((a, b) => parseInt(a.index, 10) - parseInt(b.index, 10))
    const pendingDeposits = await this.node.db.prisma.deposit.findMany({
      where: {
        queuedAt: {
          in: commits.map(commit => commit.index),
        },
      },
    })
    pendingDeposits.sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) {
        return a.blockNumber - b.blockNumber
      }
      if (a.transactionIndex !== b.transactionIndex) {
        return a.transactionIndex - b.transactionIndex
      }
      return a.logIndex - b.logIndex
    })
    deposits.push(...pendingDeposits.map(deposit => Field.from(deposit.note)))
    logger.info(`Pending deposits: ${pendingDeposits.length}`)
    consumedBytes += 32 * commits.length
    aggregatedFee = aggregatedFee.add(
      pendingDeposits.reduce((prev, item) => prev.add(item.fee), Field.zero),
    )

    // 2. pick transactions
    if (!this.gasPrice) {
      throw Error('coordinator.js: Gas price is not synced')
    }
    const txs =
      (await this.txPool.pickTxs(
        this.config.maxBytes - consumedBytes,
        160000,
        this.gasPrice.muln(this.config.priceMultiplier),
      )) || []
    aggregatedFee = aggregatedFee.add(
      txs.map(tx => tx.fee).reduce((prev, fee) => prev.add(fee), Field.zero),
    )
    logger.info(`Picked txs: ${txs.length}`)
    logger.info(`Pending txs: ${this.txPool.pendingNum()}`)
    // TODO 3 make sure every nullifier is unique and not used before
    // * if there exists invalid transactions, remove them from the tx pool and try genBlock recursively

    const utxos = txs
      .reduce((arr, tx) => {
        return [
          ...arr,
          ...tx.outflow
            .filter(outflow => outflow.outflowType.isZero())
            .map(outflow => outflow.note),
        ]
      }, deposits)
      .map(leafHash => ({ leafHash })) as Item<Field>[]

    const withdrawals = txs.reduce((arr, tx) => {
      return [
        ...arr,
        ...tx.outflow
          .filter(outflow => outflow.outflowType.eqn(1))
          .map(outflow => outflow.note),
      ]
    }, [] as Field[])

    logger.info(`Withdrawals: ${withdrawals.length}`)
    const nullifiers = txs.reduce((arr, tx) => {
      return [...arr, ...tx.inflow.map(inflow => inflow.nullifier)]
    }, [] as Field[])

    const latest = await this.node.latestBlock()
    if (!latest) {
      throw Error('Layer 2 chain is not synced yet.')
    }
    // TODO acquire lock during gen block
    const massMigrations: MassMigration[] = []
    const expectedGrove = await this.node.l2Chain.grove.dryPatch({
      utxos,
      withdrawals,
      nullifiers,
    })

    if (!expectedGrove.nullifierTreeRoot) {
      throw Error(
        'Grove does not have the nullifier tree. Use full node option',
      )
    }
    const massDeposits: MassDeposit[] = commits.map(obj => ({
      merged: Bytes32.from(obj.merged),
      fee: Uint256.from(obj.fee),
    }))
    const header: Header = {
      proposer: Address.from(this.account.address),
      parentBlock: Bytes32.from(latest),
      metadata: Bytes32.from(
        '0x0000000000000000000000000000000000000000000000000000000000000000',
      ),
      fee: aggregatedFee.toUint256(),
      utxoRoot: expectedGrove.utxoTreeRoot.toUint256(),
      utxoIndex: expectedGrove.utxoTreeIndex.toUint256(),
      nullifierRoot: bnToBytes32(expectedGrove.nullifierTreeRoot),
      withdrawalRoot: bnToBytes32(expectedGrove.withdrawalTreeRoot),
      withdrawalIndex: bnToUint256(expectedGrove.withdrawalTreeIndex),
      txRoot: root(txs.map(tx => tx.hash())),
      depositRoot: root(massDeposits.map(massDepositHash)),
      migrationRoot: root(massMigrations.map(massMigrationHash)),
    }
    const body: Body = {
      txs,
      massDeposits,
      massMigrations,
    }
    return { header, body, fee: aggregatedFee }
  }
}
