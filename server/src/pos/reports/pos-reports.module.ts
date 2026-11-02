import { Module } from '@nestjs/common';
import { PosReportsController } from './pos-reports.controller';
import { PosReportsService } from './pos-reports.service';

@Module({
  controllers: [PosReportsController],
  providers: [PosReportsService],
})
export class PosReportsModule { }
