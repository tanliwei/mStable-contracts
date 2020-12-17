/* eslint-disable no-nested-ternary */
/* eslint-disable no-await-in-loop */

import * as t from "types/generated";
import { expectEvent, expectRevert, time } from "@openzeppelin/test-helpers";
import { StandardAccounts, SystemMachine } from "@utils/machines";
import { assertBNClose, assertBNSlightlyGT, assertBNClosePercent } from "@utils/assertions";
import { simpleToExactAmount } from "@utils/math";
import { BN, fromWei } from "@utils/tools";
import { ONE_WEEK, ONE_DAY, FIVE_DAYS, fullScale, ZERO_ADDRESS } from "@utils/constants";
import envSetup from "@utils/env_setup";

const { expect } = envSetup.configure();

const MockERC20 = artifacts.require("MockERC20");
const SavingsVault = artifacts.require("BoostedSavingsVault");
const MockStakingContract = artifacts.require("MockStakingContract");

interface StakingBalance {
    raw: BN;
    balance: BN;
    totalSupply: BN;
}

interface TokenBalance {
    sender: BN;
    contract: BN;
}

interface UserData {
    rewardPerTokenPaid: BN;
    rewards: BN;
    lastAction: BN;
    rewardCount: BN;
    userClaim: BN;
}
interface ContractData {
    rewardPerTokenStored: BN;
    rewardRate: BN;
    lastUpdateTime: BN;
    lastTimeRewardApplicable: BN;
    periodFinishTime: BN;
}
interface Reward {
    start: BN;
    finish: BN;
    rate: BN;
}

interface StakingData {
    boostBalance: StakingBalance;
    tokenBalance: TokenBalance;
    vMTABalance: BN;
    userData: UserData;
    userRewards: Reward[];
    contractData: ContractData;
}

contract("SavingsVault", async (accounts) => {
    const recipientCtx: {
        recipient?: t.RewardsDistributionRecipientInstance;
    } = {};
    const moduleCtx: {
        module?: t.ModuleInstance;
    } = {};

    const sa = new StandardAccounts(accounts);
    let systemMachine: SystemMachine;
    const rewardsDistributor = sa.fundManager;

    let rewardToken: t.MockERC20Instance;
    let imUSD: t.MockERC20Instance;
    let savingsVault: t.BoostedSavingsVaultInstance;
    let stakingContract: t.MockStakingContractInstance;

    const minBoost = simpleToExactAmount(5, 17);
    const maxBoost = simpleToExactAmount(15, 17);
    const coeff = 32;

    const boost = (raw: BN, boostAmt: BN): BN => {
        return raw.mul(boostAmt).div(fullScale);
    };

    const calcBoost = (raw: BN, vMTA: BN): BN => {
        // min(d + c * vMTA^a / imUSD^b, m)
        let denom = parseFloat(fromWei(raw.divn(10)));
        denom **= 0.875;
        return BN.min(
            minBoost.add(
                vMTA
                    .muln(coeff)
                    .divn(10)
                    .mul(fullScale)
                    .div(simpleToExactAmount(denom)),
            ),
            maxBoost,
        );
    };

    const unlockedRewards = (total: BN): BN => {
        return total.divn(5);
    };

    const redeployRewards = async (
        nexusAddress = systemMachine.nexus.address,
    ): Promise<t.BoostedSavingsVaultInstance> => {
        rewardToken = await MockERC20.new("Reward", "RWD", 18, rewardsDistributor, 1000000);
        imUSD = await MockERC20.new("Interest bearing mUSD", "imUSD", 18, sa.default, 1000000);
        stakingContract = await MockStakingContract.new();
        return SavingsVault.new(
            nexusAddress,
            imUSD.address,
            stakingContract.address,
            rewardToken.address,
            rewardsDistributor,
        );
    };

    const snapshotStakingData = async (
        sender = sa.default,
        beneficiary = sa.default,
    ): Promise<StakingData> => {
        const userData = await savingsVault.userData(beneficiary);
        const userRewards = [];
        for (let i = 0; i < userData[3].toNumber(); i += 1) {
            const e = await savingsVault.userRewards(beneficiary, i);
            userRewards.push({
                start: e[0],
                finish: e[1],
                rate: e[2],
            });
        }
        return {
            boostBalance: {
                raw: await savingsVault.rawBalanceOf(beneficiary),
                balance: await savingsVault.balanceOf(beneficiary),
                totalSupply: await savingsVault.totalSupply(),
            },
            tokenBalance: {
                sender: await imUSD.balanceOf(sender),
                contract: await imUSD.balanceOf(savingsVault.address),
            },
            vMTABalance: await stakingContract.balanceOf(beneficiary),
            userData: {
                rewardPerTokenPaid: userData[0],
                rewards: userData[1],
                lastAction: userData[2],
                rewardCount: userData[3],
                userClaim: await savingsVault.userClaim(beneficiary),
            },
            userRewards,
            contractData: {
                rewardPerTokenStored: await savingsVault.rewardPerTokenStored(),
                rewardRate: await savingsVault.rewardRate(),
                lastUpdateTime: await savingsVault.lastUpdateTime(),
                lastTimeRewardApplicable: await savingsVault.lastTimeRewardApplicable(),
                periodFinishTime: await savingsVault.periodFinish(),
            },
        };
    };

    before(async () => {
        systemMachine = new SystemMachine(sa.all);
        await systemMachine.initialiseMocks(false, false);
        savingsVault = await redeployRewards();
        recipientCtx.recipient = (savingsVault as unknown) as t.RewardsDistributionRecipientInstance;
        moduleCtx.module = savingsVault as t.ModuleInstance;
    });

    describe("constructor & settings", async () => {
        before(async () => {
            savingsVault = await redeployRewards();
        });
        it("should set all initial state", async () => {
            // Set in constructor
            expect(await savingsVault.nexus(), systemMachine.nexus.address);
            expect(await savingsVault.stakingToken(), imUSD.address);
            expect(await savingsVault.stakingContract(), stakingContract.address);
            expect(await savingsVault.rewardsToken(), rewardToken.address);
            expect(await savingsVault.rewardsDistributor(), rewardsDistributor);

            // Basic storage
            expect(await savingsVault.totalSupply()).bignumber.eq(new BN(0));
            expect(await savingsVault.periodFinish()).bignumber.eq(new BN(0));
            expect(await savingsVault.rewardRate()).bignumber.eq(new BN(0));
            expect(await savingsVault.lastUpdateTime()).bignumber.eq(new BN(0));
            expect(await savingsVault.rewardPerTokenStored()).bignumber.eq(new BN(0));
            expect(await savingsVault.lastTimeRewardApplicable()).bignumber.eq(new BN(0));
            expect(await savingsVault.rewardPerToken()).bignumber.eq(new BN(0));
        });
    });

    /**
     * @dev Ensures the reward units are assigned correctly, based on the last update time, etc
     * @param beforeData Snapshot after the tx
     * @param afterData Snapshot after the tx
     * @param isExistingStaker Expect the staker to be existing?
     */
    const assertRewardsAssigned = async (
        beforeData: StakingData,
        afterData: StakingData,
        isExistingStaker: boolean,
        shouldResetRewards = false,
    ): Promise<void> => {
        const timeAfter = await time.latest();
        const periodIsFinished = new BN(timeAfter).gt(beforeData.contractData.periodFinishTime);
        //    LastUpdateTime
        expect(
            periodIsFinished
                ? beforeData.contractData.periodFinishTime
                : beforeData.contractData.rewardPerTokenStored.eqn(0) &&
                  beforeData.boostBalance.totalSupply.eqn(0)
                ? beforeData.contractData.lastUpdateTime
                : timeAfter,
        ).bignumber.eq(afterData.contractData.lastUpdateTime);
        //    RewardRate doesnt change
        expect(beforeData.contractData.rewardRate).bignumber.eq(afterData.contractData.rewardRate);
        //    RewardPerTokenStored goes up
        expect(afterData.contractData.rewardPerTokenStored).bignumber.gte(
            beforeData.contractData.rewardPerTokenStored as any,
        );
        //      Calculate exact expected 'rewardPerToken' increase since last update
        const timeApplicableToRewards = periodIsFinished
            ? beforeData.contractData.periodFinishTime.sub(beforeData.contractData.lastUpdateTime)
            : timeAfter.sub(beforeData.contractData.lastUpdateTime);
        const increaseInRewardPerToken = beforeData.boostBalance.totalSupply.eq(new BN(0))
            ? new BN(0)
            : beforeData.contractData.rewardRate
                  .mul(timeApplicableToRewards)
                  .mul(fullScale)
                  .div(beforeData.boostBalance.totalSupply);
        expect(
            beforeData.contractData.rewardPerTokenStored.add(increaseInRewardPerToken),
        ).bignumber.eq(afterData.contractData.rewardPerTokenStored);
        // Expect updated personal state
        //    userRewardPerTokenPaid(beneficiary) should update
        expect(afterData.userData.rewardPerTokenPaid).bignumber.eq(
            afterData.userData.rewardPerTokenPaid,
        );
        //    If existing staker, then rewards Should increase
        if (shouldResetRewards) {
            expect(afterData.userData.rewards).bignumber.eq(new BN(0));
        } else if (isExistingStaker) {
            // rewards(beneficiary) should update with previously accrued tokens
            const increaseInUserRewardPerToken = afterData.contractData.rewardPerTokenStored.sub(
                beforeData.userData.rewardPerTokenPaid,
            );
            const assignment = beforeData.boostBalance.balance
                .mul(increaseInUserRewardPerToken)
                .div(fullScale);
            expect(beforeData.userData.rewards.add(unlockedRewards(assignment))).bignumber.eq(
                afterData.userData.rewards,
            );
        } else {
            // else `rewards` should stay the same
            expect(beforeData.userData.rewards).bignumber.eq(afterData.userData.rewards);
        }
    };

    /**
     * @dev Ensures a stake is successful, updates the rewards for the beneficiary and
     * collects the stake
     * @param stakeAmount Exact units to stake
     * @param sender Sender of the tx
     * @param beneficiary Beneficiary of the stake
     * @param confirmExistingStaker Expect the staker to be existing?
     */
    const expectSuccessfulStake = async (
        stakeAmount: BN,
        sender = sa.default,
        beneficiary = sa.default,
        confirmExistingStaker = false,
    ): Promise<void> => {
        // 1. Get data from the contract
        const senderIsBeneficiary = sender === beneficiary;
        const beforeData = await snapshotStakingData(sender, beneficiary);

        const isExistingStaker = beforeData.boostBalance.raw.gt(new BN(0));
        if (confirmExistingStaker) {
            expect(isExistingStaker).eq(true);
        }
        // 2. Approve staking token spending and send the TX
        await imUSD.approve(savingsVault.address, stakeAmount, {
            from: sender,
        });
        const tx = await (senderIsBeneficiary
            ? savingsVault.methods["stake(uint256)"](stakeAmount, {
                  from: sender,
              })
            : savingsVault.methods["stake(address,uint256)"](beneficiary, stakeAmount, {
                  from: sender,
              }));
        expectEvent(tx.receipt, "Staked", {
            user: beneficiary,
            amount: stakeAmount,
            payer: sender,
        });

        // 3. Ensure rewards are accrued to the beneficiary
        const afterData = await snapshotStakingData(sender, beneficiary);
        const expectedBoost = boost(
            afterData.boostBalance.raw,
            calcBoost(afterData.boostBalance.raw, afterData.vMTABalance),
        );
        await assertRewardsAssigned(beforeData, afterData, isExistingStaker);

        // 4. Expect token transfer
        //    StakingToken balance of sender
        expect(beforeData.tokenBalance.sender.sub(stakeAmount)).bignumber.eq(
            afterData.tokenBalance.sender,
        );
        //    StakingToken balance of StakingRewards
        expect(beforeData.tokenBalance.contract.add(stakeAmount)).bignumber.eq(
            afterData.tokenBalance.contract,
        );
        //    TotalSupply of StakingRewards
        expect(
            beforeData.boostBalance.totalSupply
                .sub(beforeData.boostBalance.balance)
                .add(expectedBoost),
        ).bignumber.eq(afterData.boostBalance.totalSupply);
    };

    /**
     * @dev Ensures a funding is successful, checking that it updates the rewardRate etc
     * @param rewardUnits Number of units to stake
     */
    const expectSuccesfulFunding = async (rewardUnits: BN): Promise<void> => {
        const beforeData = await snapshotStakingData();
        const tx = await savingsVault.notifyRewardAmount(rewardUnits, {
            from: rewardsDistributor,
        });
        expectEvent(tx.receipt, "RewardAdded", { reward: rewardUnits });

        const cur = new BN(await time.latest());
        const leftOverRewards = beforeData.contractData.rewardRate.mul(
            beforeData.contractData.periodFinishTime.sub(
                beforeData.contractData.lastTimeRewardApplicable,
            ),
        );
        const afterData = await snapshotStakingData();

        // Sets lastTimeRewardApplicable to latest
        expect(cur).bignumber.eq(afterData.contractData.lastTimeRewardApplicable);
        // Sets lastUpdateTime to latest
        expect(cur).bignumber.eq(afterData.contractData.lastUpdateTime);
        // Sets periodFinish to 1 week from now
        expect(cur.add(ONE_WEEK)).bignumber.eq(afterData.contractData.periodFinishTime);
        // Sets rewardRate to rewardUnits / ONE_WEEK
        if (leftOverRewards.gtn(0)) {
            const total = rewardUnits.add(leftOverRewards);
            assertBNClose(
                total.div(ONE_WEEK),
                afterData.contractData.rewardRate,
                beforeData.contractData.rewardRate.div(ONE_WEEK).muln(5), // the effect of 1 second on the future scale
            );
        } else {
            expect(rewardUnits.div(ONE_WEEK)).bignumber.eq(afterData.contractData.rewardRate);
        }
    };

    /**
     * @dev Makes a withdrawal from the contract, and ensures that resulting state is correct
     * and the rewards have been applied
     * @param withdrawAmount Exact amount to withdraw
     * @param sender User to execute the tx
     */
    const expectStakingWithdrawal = async (
        withdrawAmount: BN,
        sender = sa.default,
    ): Promise<void> => {
        // 1. Get data from the contract
        const beforeData = await snapshotStakingData(sender);
        const isExistingStaker = beforeData.boostBalance.raw.gt(new BN(0));
        expect(isExistingStaker).eq(true);
        expect(withdrawAmount).bignumber.gte(beforeData.boostBalance.raw as any);

        // 2. Send withdrawal tx
        const tx = await savingsVault.withdraw(withdrawAmount, {
            from: sender,
        });
        expectEvent(tx.receipt, "Withdrawn", {
            user: sender,
            amount: withdrawAmount,
        });

        // 3. Expect Rewards to accrue to the beneficiary
        //    StakingToken balance of sender
        const afterData = await snapshotStakingData(sender);
        await assertRewardsAssigned(beforeData, afterData, isExistingStaker);

        // 4. Expect token transfer
        //    StakingToken balance of sender
        expect(beforeData.tokenBalance.sender.add(withdrawAmount)).bignumber.eq(
            afterData.tokenBalance.sender,
        );
        //    Withdraws from the actual rewards wrapper token
        expect(beforeData.boostBalance.raw.sub(withdrawAmount)).bignumber.eq(
            afterData.boostBalance.raw,
        );
        //    Updates total supply
        expect(
            beforeData.boostBalance.totalSupply
                .sub(beforeData.boostBalance.balance)
                .add(afterData.boostBalance.balance),
        ).bignumber.eq(afterData.boostBalance.totalSupply);
    };

    context("initialising and staking in a new pool", () => {
        describe("notifying the pool of reward", () => {
            it("should begin a new period through", async () => {
                const rewardUnits = simpleToExactAmount(1, 18);
                await expectSuccesfulFunding(rewardUnits);
            });
        });
        describe("staking in the new period", () => {
            it("should assign rewards to the staker", async () => {
                // Do the stake
                const rewardRate = await savingsVault.rewardRate();
                const stakeAmount = simpleToExactAmount(100, 18);
                const boosted = boost(stakeAmount, minBoost);
                await expectSuccessfulStake(stakeAmount);
                expect(boosted).bignumber.eq(await savingsVault.balanceOf(sa.default));

                await time.increase(ONE_DAY);

                // This is the total reward per staked token, since the last update
                const rewardPerToken = await savingsVault.rewardPerToken();
                const rewardPerSecond = rewardRate.mul(fullScale).div(boosted);
                assertBNClose(
                    rewardPerToken,
                    ONE_DAY.mul(rewardPerSecond),
                    rewardPerSecond.muln(10),
                );

                // Calc estimated unclaimed reward for the user
                // earned == balance * (rewardPerToken-userExistingReward)
                const earned = await savingsVault.earned(sa.default);
                expect(unlockedRewards(boosted.mul(rewardPerToken).div(fullScale))).bignumber.eq(
                    earned,
                );

                await stakingContract.setBalanceOf(sa.default, simpleToExactAmount(1, 21));
                await savingsVault.pokeBoost(sa.default);
            });
            it("should update stakers rewards after consequent stake", async () => {
                const stakeAmount = simpleToExactAmount(100, 18);
                // This checks resulting state after second stake
                await expectSuccessfulStake(stakeAmount, sa.default, sa.default, true);
            });

            it("should fail if stake amount is 0", async () => {
                await expectRevert(
                    savingsVault.methods["stake(uint256)"](0, { from: sa.default }),
                    "Cannot stake 0",
                );
            });

            it("should fail if staker has insufficient balance", async () => {
                await imUSD.approve(savingsVault.address, 1, { from: sa.dummy2 });
                await expectRevert(
                    savingsVault.methods["stake(uint256)"](1, { from: sa.dummy2 }),
                    "SafeERC20: low-level call failed",
                );
            });
        });
    });
    context("funding with too much rewards", () => {
        before(async () => {
            savingsVault = await redeployRewards();
        });
        it("should fail", async () => {
            await expectRevert(
                savingsVault.notifyRewardAmount(simpleToExactAmount(1, 25), {
                    from: sa.fundManager,
                }),
                "Cannot notify with more than a million units",
            );
        });
    });
    context("staking before rewards are added", () => {
        before(async () => {
            savingsVault = await redeployRewards();
        });
        it("should assign no rewards", async () => {
            // Get data before
            const stakeAmount = simpleToExactAmount(100, 18);
            const beforeData = await snapshotStakingData();
            expect(beforeData.contractData.rewardRate).bignumber.eq(new BN(0));
            expect(beforeData.contractData.rewardPerTokenStored).bignumber.eq(new BN(0));
            expect(beforeData.userData.rewards).bignumber.eq(new BN(0));
            expect(beforeData.boostBalance.totalSupply).bignumber.eq(new BN(0));
            expect(beforeData.contractData.lastTimeRewardApplicable).bignumber.eq(new BN(0));

            // Do the stake
            await expectSuccessfulStake(stakeAmount);

            // Wait a day
            await time.increase(ONE_DAY);

            // Do another stake
            await expectSuccessfulStake(stakeAmount);

            // Get end results
            const afterData = await snapshotStakingData();
            expect(afterData.contractData.rewardRate).bignumber.eq(new BN(0));
            expect(afterData.contractData.rewardPerTokenStored).bignumber.eq(new BN(0));
            expect(afterData.userData.rewards).bignumber.eq(new BN(0));
            expect(afterData.boostBalance.totalSupply).bignumber.eq(stakeAmount);
            expect(afterData.contractData.lastTimeRewardApplicable).bignumber.eq(new BN(0));
        });
    });

    context("calculating a users boost", async () => {
        beforeEach(async () => {
            savingsVault = await redeployRewards();
        });
        describe("calling getBoost", () => {
            it("should accurately return a users boost");
        });
        describe("calling getRequiredStake", () => {
            it("should return the amount of vMTA required to get a particular boost with a given imUSD amount", async () => {
                // fn on the contract works out the boost: function(uint256 imUSD, uint256 boost) returns (uint256 requiredVMTA)
            });
        });
        describe("when saving and with staking balance", () => {
            it("should calculate boost for 10k imUSD stake and 250 vMTA", async () => {
                const deposit = simpleToExactAmount(10000);
                const stake = simpleToExactAmount(250, 18);
                const expectedBoost = simpleToExactAmount(15000);

                await expectSuccessfulStake(deposit);
                await stakingContract.setBalanceOf(sa.default, stake);
                await savingsVault.pokeBoost(sa.default);

                const balance = await savingsVault.balanceOf(sa.default);
                expect(balance).bignumber.eq(expectedBoost);
                console.log(boost(deposit, calcBoost(deposit, stake)).toString());
                expect(boost(deposit, calcBoost(deposit, stake))).bignumber.eq(expectedBoost);
            });
            it("should calculate boost for 10k imUSD stake and 100 vMTA", async () => {
                const deposit = simpleToExactAmount(10000, 18);
                const stake = simpleToExactAmount(100, 18);
                const expectedBoost = simpleToExactAmount(12590, 18);

                await expectSuccessfulStake(deposit);
                await stakingContract.setBalanceOf(sa.default, stake);
                await savingsVault.pokeBoost(sa.default);

                const balance = await savingsVault.balanceOf(sa.default);
                console.log(balance.toString());
                assertBNClosePercent(balance, expectedBoost, "1");
                console.log(calcBoost(deposit, stake).toString());
                assertBNClosePercent(
                    boost(deposit, calcBoost(deposit, stake)),
                    expectedBoost,
                    "0.1",
                );
            });
            it("should calculate boost for 100k imUSD stake and 800 vMTA", async () => {
                const deposit = simpleToExactAmount(100000, 18);
                const stake = simpleToExactAmount(800, 18);
                const expectedBoost = simpleToExactAmount(131000, 18);

                await expectSuccessfulStake(deposit);
                await stakingContract.setBalanceOf(sa.default, stake);
                await savingsVault.pokeBoost(sa.default);

                const balance = await savingsVault.balanceOf(sa.default);
                console.log(balance.toString());
                assertBNClosePercent(balance, expectedBoost, "1");
                console.log(calcBoost(deposit, stake).toString());
                assertBNClosePercent(
                    boost(deposit, calcBoost(deposit, stake)),
                    expectedBoost,
                    "0.1",
                );
            });
        });
        describe("when saving and with staking balance = 0", () => {
            it("should give no boost");
        });
        describe("when withdrawing and with staking balance", () => {
            it("should set boost to 0 and update total supply");
        });
        describe("when withdrawing and with staking balance = 0", () => {
            it("should set boost to 0 and update total supply");
        });
    });
    context("adding first stake days after funding", () => {
        before(async () => {
            savingsVault = await redeployRewards();
        });
        it("should retrospectively assign rewards to the first staker", async () => {
            await expectSuccesfulFunding(simpleToExactAmount(100, 18));

            // Do the stake
            const rewardRate = await savingsVault.rewardRate();

            await time.increase(FIVE_DAYS);

            const stakeAmount = simpleToExactAmount(100, 18);
            const boosted = boost(stakeAmount, minBoost);
            await expectSuccessfulStake(stakeAmount);
            // await time.increase(ONE_DAY);

            // This is the total reward per staked token, since the last update
            const rewardPerToken = await savingsVault.rewardPerToken();

            // e.g. 1e15 * 1e18 / 50e18 = 2e13
            const rewardPerSecond = rewardRate.mul(fullScale).div(boosted);
            assertBNClose(rewardPerToken, FIVE_DAYS.mul(rewardPerSecond), rewardPerSecond.muln(4));

            // Calc estimated unclaimed reward for the user
            // earned == balance * (rewardPerToken-userExistingReward)
            const earnedAfterConsequentStake = await savingsVault.earned(sa.default);
            expect(unlockedRewards(boosted.mul(rewardPerToken).div(fullScale))).bignumber.eq(
                earnedAfterConsequentStake,
            );

            await stakingContract.setBalanceOf(sa.default, simpleToExactAmount(1, 21));
            await savingsVault.pokeBoost(sa.default);
        });
    });
    context("staking over multiple funded periods", () => {
        context("with a single staker", () => {
            before(async () => {
                savingsVault = await redeployRewards();
            });
            it("should assign all the rewards from the periods", async () => {
                const fundAmount1 = simpleToExactAmount(100, 18);
                const fundAmount2 = simpleToExactAmount(200, 18);
                await expectSuccesfulFunding(fundAmount1);

                const stakeAmount = simpleToExactAmount(1, 18);
                await expectSuccessfulStake(stakeAmount);

                await time.increase(ONE_WEEK.muln(2));

                await expectSuccesfulFunding(fundAmount2);

                await time.increase(ONE_WEEK.muln(2));

                const earned = await savingsVault.earned(sa.default);
                assertBNSlightlyGT(
                    unlockedRewards(fundAmount1.add(fundAmount2)),
                    earned,
                    new BN(1000000),
                    false,
                );

                await stakingContract.setBalanceOf(sa.default, simpleToExactAmount(1, 21));
                await savingsVault.pokeBoost(sa.default);
            });
        });
        context("with multiple stakers coming in and out", () => {
            const fundAmount1 = simpleToExactAmount(100, 21);
            const fundAmount2 = simpleToExactAmount(200, 21);
            const staker2 = sa.dummy1;
            const staker3 = sa.dummy2;
            const staker1Stake1 = simpleToExactAmount(100, 18);
            const staker1Stake2 = simpleToExactAmount(200, 18);
            const staker2Stake = simpleToExactAmount(100, 18);
            const staker3Stake = simpleToExactAmount(100, 18);

            before(async () => {
                savingsVault = await redeployRewards();
                await imUSD.transfer(staker2, staker2Stake);
                await imUSD.transfer(staker3, staker3Stake);
            });
            it("should accrue rewards on a pro rata basis", async () => {
                /*
                 *  0               1               2   <-- Weeks
                 *   [ - - - - - - ] [ - - - - - - ]
                 * 100k            200k                 <-- Funding
                 * +100            +200                 <-- Staker 1
                 *        +100                          <-- Staker 2
                 * +100            -100                 <-- Staker 3
                 *
                 * Staker 1 gets 25k + 16.66k from week 1 + 150k from week 2 = 191.66k
                 * Staker 2 gets 16.66k from week 1 + 50k from week 2 = 66.66k
                 * Staker 3 gets 25k + 16.66k from week 1 + 0 from week 2 = 41.66k
                 */

                // WEEK 0-1 START
                await expectSuccessfulStake(staker1Stake1);
                await expectSuccessfulStake(staker3Stake, staker3, staker3);

                await expectSuccesfulFunding(fundAmount1);

                await time.increase(ONE_WEEK.divn(2).addn(1));

                await expectSuccessfulStake(staker2Stake, staker2, staker2);

                await time.increase(ONE_WEEK.divn(2).addn(1));

                // WEEK 1-2 START
                await expectSuccesfulFunding(fundAmount2);

                await savingsVault.withdraw(staker3Stake, { from: staker3 });
                await expectSuccessfulStake(staker1Stake2, sa.default, sa.default, true);

                await time.increase(ONE_WEEK);

                // WEEK 2 FINISH
                const earned1 = await savingsVault.earned(sa.default);
                assertBNClose(
                    earned1,
                    unlockedRewards(simpleToExactAmount("191.66", 21)),
                    simpleToExactAmount(1, 19),
                );
                const earned2 = await savingsVault.earned(staker2);
                assertBNClose(
                    earned2,
                    unlockedRewards(simpleToExactAmount("66.66", 21)),
                    simpleToExactAmount(1, 19),
                );
                const earned3 = await savingsVault.earned(staker3);
                assertBNClose(
                    earned3,
                    unlockedRewards(simpleToExactAmount("41.66", 21)),
                    simpleToExactAmount(1, 19),
                );
                // Ensure that sum of earned rewards does not exceed funding amount
                expect(fundAmount1.add(fundAmount2)).bignumber.gte(
                    earned1.add(earned2).add(earned3) as any,
                );
            });
        });
    });
    context("staking after period finish", () => {
        const fundAmount1 = simpleToExactAmount(100, 21);

        before(async () => {
            savingsVault = await redeployRewards();
        });
        it("should stop accruing rewards after the period is over", async () => {
            await expectSuccessfulStake(simpleToExactAmount(1, 18));
            await expectSuccesfulFunding(fundAmount1);

            await time.increase(ONE_WEEK.addn(1));

            const earnedAfterWeek = await savingsVault.earned(sa.default);

            await time.increase(ONE_WEEK.addn(1));
            const now = await time.latest();

            const earnedAfterTwoWeeks = await savingsVault.earned(sa.default);

            expect(earnedAfterWeek).bignumber.eq(earnedAfterTwoWeeks);

            const lastTimeRewardApplicable = await savingsVault.lastTimeRewardApplicable();
            assertBNClose(lastTimeRewardApplicable, now.sub(ONE_WEEK).subn(2), new BN(2));
        });
    });
    context("staking on behalf of a beneficiary", () => {
        const fundAmount = simpleToExactAmount(100, 21);
        const beneficiary = sa.dummy1;
        const stakeAmount = simpleToExactAmount(100, 18);

        before(async () => {
            savingsVault = await redeployRewards();
            await expectSuccesfulFunding(fundAmount);
            await expectSuccessfulStake(stakeAmount, sa.default, beneficiary);
            await time.increase(10);
        });
        it("should update the beneficiaries reward details", async () => {
            const earned = await savingsVault.earned(beneficiary);
            expect(earned).bignumber.gt(new BN(0) as any);

            const rawBalance = await savingsVault.rawBalanceOf(beneficiary);
            expect(rawBalance).bignumber.eq(stakeAmount);

            const balance = await savingsVault.balanceOf(beneficiary);
            expect(balance).bignumber.eq(boost(stakeAmount, minBoost));
        });
        it("should not update the senders details", async () => {
            const earned = await savingsVault.earned(sa.default);
            expect(earned).bignumber.eq(new BN(0));

            const balance = await savingsVault.balanceOf(sa.default);
            expect(balance).bignumber.eq(new BN(0));
        });
    });
    context("using staking / reward tokens with diff decimals", () => {
        before(async () => {
            rewardToken = await MockERC20.new("Reward", "RWD", 12, rewardsDistributor, 1000000);
            imUSD = await MockERC20.new("Interest bearing mUSD", "imUSD", 16, sa.default, 1000000);
            stakingContract = await MockStakingContract.new();
            savingsVault = await SavingsVault.new(
                systemMachine.nexus.address,
                imUSD.address,
                stakingContract.address,
                rewardToken.address,
                rewardsDistributor,
            );
        });
        it("should not affect the pro rata payouts", async () => {
            // Add 100 reward tokens
            await expectSuccesfulFunding(simpleToExactAmount(100, 12));
            const rewardRate = await savingsVault.rewardRate();

            // Do the stake
            const stakeAmount = simpleToExactAmount(100, 16);
            const boosted = boost(stakeAmount, minBoost);
            await expectSuccessfulStake(stakeAmount);

            await time.increase(ONE_WEEK.addn(1));

            // This is the total reward per staked token, since the last update
            const rewardPerToken = await savingsVault.rewardPerToken();
            assertBNClose(
                rewardPerToken,
                ONE_WEEK.mul(rewardRate)
                    .mul(fullScale)
                    .div(boosted),
                new BN(1)
                    .mul(rewardRate)
                    .mul(fullScale)
                    .div(boosted),
            );

            // Calc estimated unclaimed reward for the user
            // earned == balance * (rewardPerToken-userExistingReward)
            const earnedAfterConsequentStake = await savingsVault.earned(sa.default);
            assertBNSlightlyGT(
                unlockedRewards(simpleToExactAmount(100, 12)),
                earnedAfterConsequentStake,
                simpleToExactAmount(1, 9),
            );
        });
    });

    context("claiming rewards", async () => {
        const fundAmount = simpleToExactAmount(100, 21);
        const stakeAmount = simpleToExactAmount(100, 18);
        const unlocked = unlockedRewards(fundAmount);

        before(async () => {
            savingsVault = await redeployRewards();
            await expectSuccesfulFunding(fundAmount);
            await rewardToken.transfer(savingsVault.address, fundAmount, {
                from: rewardsDistributor,
            });
            await expectSuccessfulStake(stakeAmount, sa.default, sa.dummy2);
            await time.increase(ONE_WEEK.addn(1));
        });
        it("should do nothing for a non-staker", async () => {
            const beforeData = await snapshotStakingData(sa.dummy1, sa.dummy1);
            await savingsVault.methods["claimRewards()"]({ from: sa.dummy1 });

            const afterData = await snapshotStakingData(sa.dummy1, sa.dummy1);
            expect(beforeData.userData.rewards).bignumber.eq(new BN(0));
            expect(afterData.userData.rewards).bignumber.eq(new BN(0));
            expect(afterData.tokenBalance.sender).bignumber.eq(new BN(0));
            expect(afterData.userData.rewardPerTokenPaid).bignumber.eq(
                afterData.contractData.rewardPerTokenStored,
            );
        });
        it("should send all accrued rewards to the rewardee", async () => {
            const beforeData = await snapshotStakingData(sa.dummy2, sa.dummy2);
            const rewardeeBalanceBefore = await rewardToken.balanceOf(sa.dummy2);
            expect(rewardeeBalanceBefore).bignumber.eq(new BN(0));
            const tx = await savingsVault.methods["claimRewards(uint256,uint256)"](0, 0, {
                from: sa.dummy2,
            });
            expectEvent(tx.receipt, "RewardPaid", {
                user: sa.dummy2,
            });
            const afterData = await snapshotStakingData(sa.dummy2, sa.dummy2);
            await assertRewardsAssigned(beforeData, afterData, false, true);
            // Balance transferred to the rewardee
            const rewardeeBalanceAfter = await rewardToken.balanceOf(sa.dummy2);
            assertBNClose(rewardeeBalanceAfter, unlocked, simpleToExactAmount(1, 16));

            // 'rewards' reset to 0
            expect(afterData.userData.rewards).bignumber.eq(new BN(0));
            // Paid up until the last block
            expect(afterData.userData.rewardPerTokenPaid).bignumber.eq(
                afterData.contractData.rewardPerTokenStored,
            );
            // Token balances dont change
            expect(afterData.tokenBalance.sender).bignumber.eq(beforeData.tokenBalance.sender);
            expect(beforeData.boostBalance.balance).bignumber.eq(afterData.boostBalance.balance);
        });
    });

    context("getting the reward token", () => {
        before(async () => {
            savingsVault = await redeployRewards();
        });
        it("should simply return the rewards Token", async () => {
            const readToken = await savingsVault.getRewardToken();
            expect(readToken).eq(rewardToken.address);
            expect(readToken).eq(await savingsVault.rewardsToken());
        });
    });

    context("notifying new reward amount", () => {
        context("from someone other than the distributor", () => {
            before(async () => {
                savingsVault = await redeployRewards();
            });
            it("should fail", async () => {
                await expectRevert(
                    savingsVault.notifyRewardAmount(1, { from: sa.default }),
                    "Caller is not reward distributor",
                );
                await expectRevert(
                    savingsVault.notifyRewardAmount(1, { from: sa.dummy1 }),
                    "Caller is not reward distributor",
                );
                await expectRevert(
                    savingsVault.notifyRewardAmount(1, { from: sa.governor }),
                    "Caller is not reward distributor",
                );
            });
        });
        context("before current period finish", async () => {
            const funding1 = simpleToExactAmount(100, 18);
            const funding2 = simpleToExactAmount(200, 18);
            beforeEach(async () => {
                savingsVault = await redeployRewards();
            });
            it("should factor in unspent units to the new rewardRate", async () => {
                // Do the initial funding
                await expectSuccesfulFunding(funding1);
                const actualRewardRate = await savingsVault.rewardRate();
                const expectedRewardRate = funding1.div(ONE_WEEK);
                expect(expectedRewardRate).bignumber.eq(actualRewardRate);

                // Zoom forward half a week
                await time.increase(ONE_WEEK.divn(2));

                // Do the second funding, and factor in the unspent units
                const expectedLeftoverReward = funding1.divn(2);
                await expectSuccesfulFunding(funding2);
                const actualRewardRateAfter = await savingsVault.rewardRate();
                const totalRewardsForWeek = funding2.add(expectedLeftoverReward);
                const expectedRewardRateAfter = totalRewardsForWeek.div(ONE_WEEK);
                assertBNClose(
                    actualRewardRateAfter,
                    expectedRewardRateAfter,
                    actualRewardRate.div(ONE_WEEK).muln(20),
                );
            });
            it("should factor in unspent units to the new rewardRate if instant", async () => {
                // Do the initial funding
                await expectSuccesfulFunding(funding1);
                const actualRewardRate = await savingsVault.rewardRate();
                const expectedRewardRate = funding1.div(ONE_WEEK);
                expect(expectedRewardRate).bignumber.eq(actualRewardRate);

                // Zoom forward half a week
                await time.increase(1);

                // Do the second funding, and factor in the unspent units
                await expectSuccesfulFunding(funding2);
                const actualRewardRateAfter = await savingsVault.rewardRate();
                const expectedRewardRateAfter = funding1.add(funding2).div(ONE_WEEK);
                assertBNClose(
                    actualRewardRateAfter,
                    expectedRewardRateAfter,
                    actualRewardRate.div(ONE_WEEK).muln(20),
                );
            });
        });

        context("after current period finish", () => {
            const funding1 = simpleToExactAmount(100, 18);
            before(async () => {
                savingsVault = await redeployRewards();
            });
            it("should start a new period with the correct rewardRate", async () => {
                // Do the initial funding
                await expectSuccesfulFunding(funding1);
                const actualRewardRate = await savingsVault.rewardRate();
                const expectedRewardRate = funding1.div(ONE_WEEK);
                expect(expectedRewardRate).bignumber.eq(actualRewardRate);

                // Zoom forward half a week
                await time.increase(ONE_WEEK.addn(1));

                // Do the second funding, and factor in the unspent units
                await expectSuccesfulFunding(funding1.muln(2));
                const actualRewardRateAfter = await savingsVault.rewardRate();
                const expectedRewardRateAfter = expectedRewardRate.muln(2);
                expect(actualRewardRateAfter).bignumber.eq(expectedRewardRateAfter);
            });
        });
    });

    context("withdrawing stake or rewards", () => {
        context("withdrawing a stake amount", () => {
            const fundAmount = simpleToExactAmount(100, 21);
            const stakeAmount = simpleToExactAmount(100, 18);

            before(async () => {
                savingsVault = await redeployRewards();
                await expectSuccesfulFunding(fundAmount);
                await expectSuccessfulStake(stakeAmount);
                await time.increase(10);
            });
            it("should revert for a non-staker", async () => {
                await expectRevert(
                    savingsVault.withdraw(1, { from: sa.dummy1 }),
                    "SafeMath: subtraction overflow",
                );
            });
            it("should revert if insufficient balance", async () => {
                await expectRevert(
                    savingsVault.withdraw(stakeAmount.addn(1), { from: sa.default }),
                    "SafeMath: subtraction overflow",
                );
            });
            it("should fail if trying to withdraw 0", async () => {
                await expectRevert(
                    savingsVault.withdraw(0, { from: sa.default }),
                    "Cannot withdraw 0",
                );
            });
            it("should withdraw the stake and update the existing reward accrual", async () => {
                // Check that the user has earned something
                const earnedBefore = await savingsVault.earned(sa.default);
                expect(earnedBefore).bignumber.gt(new BN(0) as any);
                // const rewardsBefore = await savingsVault.rewards(sa.default);
                // expect(rewardsBefore).bignumber.eq(new BN(0));

                // Execute the withdrawal
                await expectStakingWithdrawal(stakeAmount);

                // Ensure that the new awards are added + assigned to user
                const earnedAfter = await savingsVault.earned(sa.default);
                expect(earnedAfter).bignumber.gte(earnedBefore as any);
                // const rewardsAfter = await savingsVault.rewards(sa.default);
                // expect(rewardsAfter).bignumber.eq(earnedAfter);

                // Zoom forward now
                await time.increase(10);

                // Check that the user does not earn anything else
                const earnedEnd = await savingsVault.earned(sa.default);
                expect(earnedEnd).bignumber.eq(earnedAfter);
                // const rewardsEnd = await savingsVault.rewards(sa.default);
                // expect(rewardsEnd).bignumber.eq(rewardsAfter);

                // Cannot withdraw anything else
                await expectRevert(
                    savingsVault.withdraw(stakeAmount.addn(1), { from: sa.default }),
                    "SafeMath: subtraction overflow",
                );
            });
        });
    });
});
