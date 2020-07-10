import { Wallet, providers, utils } from 'ethers'
import { solidity } from 'ethereum-waffle'
import { expect, use } from 'chai'
import { beforeEachWithFixture } from './utils/beforeEachWithFixture'
import { setupDeploy } from '../scripts/utils'
import { TrustTokenFactory } from '../build/types/TrustTokenFactory'
import { TrustToken } from '../build/types/TrustToken'
import { RegistryFactory } from '../build/types/RegistryFactory'
import { timeTravel } from './utils/timeTravel'

const parseTT = (amount: number) => utils.bigNumberify(amount).mul(10 ** 8)

use(solidity)

describe('TrustToken', () => {
  let owner: Wallet, holder: Wallet, saftHolder: Wallet
  let trustToken: TrustToken
  let provider: providers.JsonRpcProvider

  beforeEachWithFixture(async (_provider, wallets) => {
    ([owner, holder, saftHolder] = wallets)
    provider = _provider
    const deployContract = setupDeploy(owner)
    trustToken = await deployContract(TrustTokenFactory)
    const registry = await deployContract(RegistryFactory)
    await trustToken.initialize(registry.address)
    await trustToken.mint(holder.address, parseTT(1000))
  })

  describe('TimeLock', () => {
    const YEAR = 365 * 24 * 3600
    let initializationTimestamp: number

    beforeEach(async () => {
      const tx = await trustToken.initializeLockup()
      initializationTimestamp = (await provider.getBlock(tx.blockNumber)).timestamp
      await trustToken.connect(holder).registerLockup(saftHolder.address, parseTT(100))
    })

    it('correctly setups epoch start', async () => {
      expect(await trustToken.lockStart()).to.equal(initializationTimestamp)
      expect(await trustToken.epochsPassed()).to.equal(0)
      expect(await trustToken.lastEpoch()).to.equal(initializationTimestamp)
      expect(await trustToken.nextEpoch()).to.equal(initializationTimestamp + YEAR / 4)
      expect(await trustToken.finalEpoch()).to.equal(initializationTimestamp + YEAR * 2)
    })

    it('does not unlock funds until epoch passes', async () => {
      await timeTravel(provider, YEAR / 4 - 10)

      expect(await trustToken.epochsPassed()).to.equal(0)
      expect(await trustToken.balanceOf(saftHolder.address)).to.equal(parseTT(100))
      expect(await trustToken.lockedBalance(saftHolder.address)).to.equal(parseTT(100))
      expect(await trustToken.unlockedBalance(saftHolder.address)).to.equal(0)
    })

    it('unlocks 1/8 of locked funds after epoch passes', async () => {
      await timeTravel(provider, YEAR / 4)

      expect(await trustToken.epochsPassed()).to.equal(1)
      expect(await trustToken.unlockedBalance(saftHolder.address)).to.equal(parseTT(100).div(8))
      expect(await trustToken.lockedBalance(saftHolder.address)).to.equal(parseTT(100).div(8).mul(7))
      expect(await trustToken.balanceOf(saftHolder.address)).to.equal(parseTT(100))

      await timeTravel(provider, YEAR / 4)

      expect(await trustToken.epochsPassed()).to.equal(2)
      expect(await trustToken.unlockedBalance(saftHolder.address)).to.equal(parseTT(100).div(8).mul(2))
      expect(await trustToken.lockedBalance(saftHolder.address)).to.equal(parseTT(100).div(8).mul(6))
      expect(await trustToken.balanceOf(saftHolder.address)).to.equal(parseTT(100))
    })

    it('unlocks all funds after 2 years pass', async () => {
      await timeTravel(provider, YEAR * 2)

      expect(await trustToken.unlockedBalance(saftHolder.address)).to.equal(parseTT(100))
      expect(await trustToken.lockedBalance(saftHolder.address)).to.equal(0)
      expect(await trustToken.balanceOf(saftHolder.address)).to.equal(parseTT(100))

      await timeTravel(provider, YEAR * 10)

      expect(await trustToken.unlockedBalance(saftHolder.address)).to.equal(parseTT(100))
      expect(await trustToken.lockedBalance(saftHolder.address)).to.equal(0)
      expect(await trustToken.balanceOf(saftHolder.address)).to.equal(parseTT(100))
    })

    it('is impossible to give lock funds twice to a person', async () => {
      await expect(trustToken.connect(holder).registerLockup(saftHolder.address, parseTT(100))).to.be.revertedWith('distribution already set')
    })

    context('Transfers', () => {
      it('cannot transfer locked funds', async () => {
        await expect(trustToken.connect(saftHolder).transfer(owner.address, 1)).to.be.revertedWith('attempting to transfer locked funds')
      })

      it('can transfer unlocked funds', async () => {
        await timeTravel(provider, YEAR / 4)

        await trustToken.connect(saftHolder).transfer(owner.address, parseTT(100).div(8))

        expect(await trustToken.unlockedBalance(saftHolder.address)).to.equal(0)
        expect(await trustToken.lockedBalance(saftHolder.address)).to.equal(parseTT(100).div(8).mul(7))
        expect(await trustToken.balanceOf(saftHolder.address)).to.equal(parseTT(100).div(8).mul(7))
      })

      it('cannot transfer more than unlocked funds', async () => {
        await timeTravel(provider, YEAR / 4)

        await expect(trustToken.connect(saftHolder).transfer(owner.address, parseTT(100).div(8).add(1))).to.be.revertedWith('attempting to transfer locked funds')
      })

      it('if account has received tokens in normal way, they are transferable', async () => {
        await trustToken.connect(holder).transfer(saftHolder.address, parseTT(10))

        expect(await trustToken.balanceOf(saftHolder.address)).to.equal(parseTT(110))
        expect(await trustToken.lockedBalance(saftHolder.address)).to.equal(parseTT(100))

        await trustToken.connect(saftHolder).transfer(owner.address, parseTT(10))

        expect(await trustToken.balanceOf(saftHolder.address)).to.equal(parseTT(100))
        expect(await trustToken.balanceOf(owner.address)).to.equal(parseTT(10))
      })

      it('if account has received tokens in normal way, they are transferable after some epochs has passed', async () => {
        await timeTravel(provider, YEAR / 2)
        await trustToken.connect(holder).transfer(saftHolder.address, parseTT(10))

        await trustToken.connect(saftHolder).transfer(owner.address, parseTT(35))

        expect(await trustToken.balanceOf(saftHolder.address)).to.equal(parseTT(75))
        expect(await trustToken.balanceOf(owner.address)).to.equal(parseTT(35))

        await expect(trustToken.connect(saftHolder).transfer(owner.address, 1)).to.be.revertedWith('attempting to transfer locked funds')
      })

      it('cannot transfer more than balance', async () => {
        await expect(trustToken.connect(saftHolder).transfer(owner.address, parseTT(100).add(1))).to.be.revertedWith('insufficient balance')
      })

      describe('transferFrom', () => {
        beforeEach(async () => {
          await trustToken.connect(saftHolder).approve(holder.address, parseTT(100))
        })

        it('cannot transfer locked funds', async () => {
          await expect(trustToken.connect(holder).transferFrom(saftHolder.address, owner.address, 1)).to.be.revertedWith('attempting to transfer locked funds')
        })

        it('can transfer unlocked funds', async () => {
          await timeTravel(provider, YEAR / 4)
          await trustToken.connect(holder).transferFrom(saftHolder.address, owner.address, parseTT(100).div(8))

          expect(await trustToken.unlockedBalance(saftHolder.address)).to.equal(0)
          expect(await trustToken.lockedBalance(saftHolder.address)).to.equal(parseTT(100).div(8).mul(7))
          expect(await trustToken.balanceOf(saftHolder.address)).to.equal(parseTT(100).div(8).mul(7))
        })

        it('cannot transfer more than unlocked funds', async () => {
          await timeTravel(provider, YEAR / 4)

          await expect(trustToken.connect(holder).transferFrom(saftHolder.address, owner.address, parseTT(100).div(8).add(1))).to.be.revertedWith('attempting to transfer locked funds')
        })

        it('if account has received tokens in normal way, they are transferable', async () => {
          await trustToken.connect(holder).transfer(saftHolder.address, parseTT(10))

          expect(await trustToken.balanceOf(saftHolder.address)).to.equal(parseTT(110))
          expect(await trustToken.lockedBalance(saftHolder.address)).to.equal(parseTT(100))

          await trustToken.connect(holder).transferFrom(saftHolder.address, owner.address, parseTT(10))

          expect(await trustToken.balanceOf(saftHolder.address)).to.equal(parseTT(100))
          expect(await trustToken.balanceOf(owner.address)).to.equal(parseTT(10))
        })

        it('if account has received tokens in normal way, they are transferable after some epochs has passed', async () => {
          await timeTravel(provider, YEAR / 2)
          await trustToken.connect(holder).transfer(saftHolder.address, parseTT(10))

          await trustToken.connect(holder).transferFrom(saftHolder.address, owner.address, parseTT(35))

          expect(await trustToken.balanceOf(saftHolder.address)).to.equal(parseTT(75))
          expect(await trustToken.balanceOf(owner.address)).to.equal(parseTT(35))

          await expect(trustToken.connect(holder).transferFrom(saftHolder.address, owner.address, 1)).to.be.revertedWith('attempting to transfer locked funds')
        })

        it('cannot transfer more than balance', async () => {
          await expect(trustToken.connect(holder).transferFrom(saftHolder.address, owner.address, parseTT(100).add(1))).to.be.revertedWith('insufficient balance')
        })
      })
    })
  })
})