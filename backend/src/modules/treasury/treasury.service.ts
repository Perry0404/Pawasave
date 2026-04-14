import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { createPublicClient, createWalletClient, http, parseAbi, formatUnits } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const USDC_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

@Injectable()
export class TreasuryService {
  private readonly logger = new Logger(TreasuryService.name);
  private readonly publicClient;
  private readonly walletClient;
  private readonly usdcAddress: `0x${string}`;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    const rpcUrl = this.config.get<string>('BASE_RPC_URL', 'https://mainnet.base.org');
    this.usdcAddress = this.config.get<string>(
      'USDC_CONTRACT_ADDRESS',
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    ) as `0x${string}`;

    this.publicClient = createPublicClient({
      chain: base,
      transport: http(rpcUrl),
    });

    const privateKey = this.config.get<string>('TREASURY_WALLET_PRIVATE_KEY');
    if (privateKey) {
      const account = privateKeyToAccount(privateKey as `0x${string}`);
      this.walletClient = createWalletClient({
        account,
        chain: base,
        transport: http(rpcUrl),
      });
    }
  }

  /** Get treasury USDC balance on Base L2 */
  async getTreasuryBalance(): Promise<string> {
    const address = this.config.get<string>('TREASURY_WALLET_ADDRESS');
    if (!address) return '0';

    const balance = await this.publicClient.readContract({
      address: this.usdcAddress,
      abi: USDC_ABI,
      functionName: 'balanceOf',
      args: [address as `0x${string}`],
    });

    return formatUnits(balance as bigint, 6);
  }

  /** Transfer USDC from treasury to user's Base wallet */
  async transferUsdcToUser(toAddress: string, amount: bigint): Promise<string | null> {
    if (!this.walletClient) {
      this.logger.warn('Treasury wallet not configured, skipping on-chain transfer');
      return null;
    }

    const hash = await this.walletClient.writeContract({
      address: this.usdcAddress,
      abi: USDC_ABI,
      functionName: 'transfer',
      args: [toAddress as `0x${string}`, amount],
    });

    // Record in treasury ledger
    await this.prisma.treasuryLedger.create({
      data: {
        type: 'PAYOUT',
        amountUsdc: amount,
        txHash: hash,
        description: `Transfer ${formatUnits(amount, 6)} USDC to ${toAddress}`,
      },
    });

    this.logger.log(`Treasury transfer: ${formatUnits(amount, 6)} USDC to ${toAddress} (tx: ${hash})`);
    return hash;
  }

  /** Get treasury stats */
  async getStats() {
    const onChainBalance = await this.getTreasuryBalance();

    const [totalSettled, totalAdvanced] = await Promise.all([
      this.prisma.treasuryLedger.aggregate({
        where: { type: 'SETTLE_PAYMENT' },
        _sum: { amountUsdc: true },
      }),
      this.prisma.treasuryLedger.aggregate({
        where: { type: 'LIQUIDITY_ADVANCE' },
        _sum: { amountUsdc: true },
      }),
    ]);

    return {
      onChainBalanceUsdc: onChainBalance,
      totalSettledUsdc: totalSettled._sum.amountUsdc?.toString() || '0',
      totalAdvancedUsdc: totalAdvanced._sum.amountUsdc?.toString() || '0',
    };
  }
}
