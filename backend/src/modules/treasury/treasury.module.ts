import { Module } from '@nestjs/common';
import { TreasuryService } from './treasury.service';
import { ExchangeRateModule } from '../exchange-rate/exchange-rate.module';

@Module({
  imports: [ExchangeRateModule],
  providers: [TreasuryService],
  exports: [TreasuryService],
})
export class TreasuryModule {}
