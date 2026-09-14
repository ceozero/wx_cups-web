export type JobStatus = 'received' | 'downloading' | 'validating' | 'submitting' | 'accepted' | 'rejected' | 'uncertain' | 'failed';

export interface StoredMessage {
  msgId: string;
  userId: string;
  status: JobStatus;
  result?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PrintableFile {
  filename: string;
  contentType: string;
  buffer: Buffer;
}

export interface IncomingMessage {
  msgId: string;
  userId: string;
  /** 延迟下载，确保去重成功后才拉取企业微信的媒体文件。 */
  loadFiles: () => Promise<PrintableFile[]>;
}

export interface PrintReceipt {
  jobId: string | number;
  pages?: number;
  filename?: string;
}

export interface ProcessingResult {
  status: JobStatus;
  reply: string;
  receipts?: PrintReceipt[];
}

export interface PrinterSubmitter {
  /** 以对应个人微信用户映射的 cups-web 身份提交任务。 */
  submit(file: PrintableFile, userId: string): Promise<PrintReceipt>;
}

export type PendingPrintKind = 'text' | 'image' | 'file';

/** 已经由用户发送、但尚未在客服菜单中确认的打印请求。 */
export interface PendingPrint {
  msgId: string;
  userId: string;
  openKfId: string;
  kind: PendingPrintKind;
  payload: string;
  status: 'pending' | 'confirmed' | 'cancelled';
  expiresAt: number;
  createdAt: number;
}

/** 需要从 CUPS 查询最终状态的已提交任务。 */
export interface TrackedPrintJob {
  messageId: string;
  userId: string;
  openKfId: string;
  jobId: string;
  status: 'submitted' | 'completed' | 'failed' | 'timeout';
  createdAt: number;
}

/** 面向客户展示的近期打印记录，仅保存必要元数据，不保存文件内容。 */
export interface PrintHistoryRecord {
  messageId: string;
  userId: string;
  filename: string;
  jobId: string;
  pages?: number;
  status: 'submitted' | 'completed' | 'failed' | 'timeout';
  createdAt: number;
}
