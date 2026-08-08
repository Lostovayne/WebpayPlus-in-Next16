export interface EmailMessage {
  to: string;
  from?: string;
  subject: string;
  html: string;
}

export interface EmailResult {
  id: string | null;
  provider: string;
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<EmailResult>;
}
