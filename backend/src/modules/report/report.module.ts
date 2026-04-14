import { Module } from '@nestjs/common';
import { ReportService } from './report.service';
import { ReportController } from './report.controller';
import { ExchangeRateModule } from '../exchange-rate/exchange-rate.module';

@Module({
  imports: [ExchangeRateModule],
  controllers: [ReportController],
  providers: [ReportService],
  exports: [ReportService],
})
export class ReportModule {}
