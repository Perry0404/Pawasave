import { Module, forwardRef } from '@nestjs/common';
import { SplitService } from './split.service';
import { SplitController } from './split.controller';
import { WalletModule } from '../wallet/wallet.module';
import { ExchangeRateModule } from '../exchange-rate/exchange-rate.module';

@Module({
  imports: [forwardRef(() => WalletModule), ExchangeRateModule],
  controllers: [SplitController],
  providers: [SplitService],
  exports: [SplitService],
})
export class SplitModule {}
