import { Resend } from "resend";
import {
  EmailMessage,
  EmailProvider,
  EmailResult,
} from "@/features/auth/domain/email-provider";

/**
 * Infrastructure adapter for Resend email service.
 * Translates between the domain EmailProvider interface and the Resend SDK.
 */
export class ResendEmailProvider implements EmailProvider {
  readonly name = "resend";

  private readonly resend: Resend;
  private readonly fromEmail: string;

  constructor(apiKey: string, fromEmail?: string) {
    this.resend = new Resend(apiKey);
    this.fromEmail = fromEmail ?? "noreply@localhost";
  }

  async send(message: EmailMessage): Promise<EmailResult> {
    const { data, error } = await this.resend.emails.send({
      from: message.from ?? this.fromEmail,
      to: message.to,
      subject: message.subject,
      html: message.html,
    });

    if (error) {
      throw new Error(`Resend error: ${error.message}`);
    }

    return {
      id: data?.id ?? null,
      provider: this.name,
    };
  }
}
