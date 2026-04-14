import { Module } from '@nestjs/common';
import { SavingsService } from './savings.service';
import { ExchangeRateModule } from '../exchange-rate/exchange-rate.module';

@Module({
  imports: [ExchangeRateModule],
  providers: [SavingsService],
  exports: [SavingsService],
})
export class SavingsModule {}
