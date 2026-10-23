// ============================================================
// Communication Department — Email Provider (SMTP + IMAP)
// Concrete implementation of EmailProviderInterface using
// nodemailer (send) and imapflow (read).
// ============================================================

import * as nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { createLayerLogger } from '../../shared/logger';
import {
  EmailProviderInterface,
  SmtpImapConfig,
  EmailMessage,
  EmailThread,
  EmailFilter,
} from './types';

const log = createLayerLogger('EmailProvider');

/**
 * SmtpImapProvider — sends email via SMTP (nodemailer) and reads
 * via IMAP (imapflow).  Implements the `EmailProviderInterface`
 * contract so the executor never touches transport details.
 */
export class SmtpImapProvider implements EmailProviderInterface {
  private transporter: nodemailer.Transporter;
  private config: SmtpImapConfig;

  constructor(config: SmtpImapConfig) {
    this.config = config;

    this.transporter = nodemailer.createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpPort === 465,
      auth: {
        user: config.user,
        pass: config.pass,
      },
    });

    log.info('SMTP transport created', {
      host: config.smtpHost,
      port: config.smtpPort,
    });
  }

  // ── Send ────────────────────────────────────────────────────

  async sendEmail(
    msg: Pick<EmailMessage, 'to' | 'cc' | 'bcc' | 'subject' | 'body'>
  ): Promise<string> {
    const mailOptions: nodemailer.SendMailOptions = {
      from: this.config.fromAddress,
      to: Array.isArray(msg.to) ? msg.to.join(', ') : msg.to,
      cc: msg.cc?.join(', '),
      bcc: msg.bcc?.join(', '),
      subject: msg.subject,
      text: msg.body,
    };

    log.info('Sending email', {
      to: mailOptions.to,
      subject: mailOptions.subject,
    });

    const info = await this.transporter.sendMail(mailOptions);

    log.info('Email sent', { messageId: info.messageId });
    return info.messageId as string;
  }

  // ── Read ────────────────────────────────────────────────────

  async readEmails(filter: EmailFilter = {}): Promise<EmailMessage[]> {
    const client = this.createImapClient();

    try {
      await client.connect();

      const folder = filter.folder || 'INBOX';
      const lock = await client.getMailboxLock(folder);

      try {
        const messages: EmailMessage[] = [];
        const limit = filter.limit ?? 10;

        // Build IMAP search criteria
        const searchCriteria: Record<string, unknown> = {};
        if (filter.unreadOnly) searchCriteria.seen = false;
        if (filter.from) searchCriteria.from = filter.from;
        if (filter.since) searchCriteria.since = new Date(filter.since);

        const hasSearch = Object.keys(searchCriteria).length > 0;
        const uids = hasSearch
          ? await client.search(searchCriteria, { uid: true })
          : undefined;

        // If search returned nothing, return empty
        if (hasSearch && (!uids || uids.length === 0)) {
          return [];
        }

        const mailboxExists = typeof client.mailbox === 'object' && client.mailbox ? client.mailbox.exists : limit;
        const range = uids
          ? uids.slice(-limit).join(',')
          : `${Math.max(1, mailboxExists - limit + 1)}:*`;

        for await (const msg of client.fetch(range, {
          envelope: true,
          source: false,
          bodyStructure: true,
          uid: true,
        })) {
          const envelope = msg.envelope;
          if (!envelope) continue;

          messages.push({
            messageId: envelope.messageId || undefined,
            from: envelope.from?.[0]
              ? `${envelope.from[0].name || ''} <${envelope.from[0].address || ''}>`
              : 'unknown',
            to: (envelope.to || []).map(
              (a: { name?: string; address?: string }) =>
                `${a.name || ''} <${a.address || ''}>`.trim()
            ),
            subject: envelope.subject || '(no subject)',
            body: '', // Full body fetch is expensive; caller can request thread for full content
            date: envelope.date ? new Date(envelope.date).toISOString() : new Date().toISOString(),
            inReplyTo: envelope.inReplyTo || undefined,
          });
        }

        return messages.slice(-limit);
      } finally {
        lock.release();
      }
    } catch (error) {
      log.error('IMAP read failed', { error: (error as Error).message });
      throw error;
    } finally {
      await client.logout().catch(() => {});
    }
  }

  // ── Thread ──────────────────────────────────────────────────

  async getThread(threadId: string): Promise<EmailThread | null> {
    const client = this.createImapClient();

    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');

      try {
        // Search for messages referencing this thread ID
        const uidsResult = await client.search(
          { header: { 'message-id': threadId } },
          { uid: true }
        );
        const uids = Array.isArray(uidsResult) ? uidsResult : [];

        // Also search References header
        const refUidsResult = await client.search(
          { header: { references: threadId } },
          { uid: true }
        );
        const refUids = Array.isArray(refUidsResult) ? refUidsResult : [];

        const allUids = [...new Set([...uids, ...refUids])];
        if (allUids.length === 0) return null;

        const messages: EmailMessage[] = [];

        for await (const msg of client.fetch(allUids.join(','), {
          envelope: true,
          source: true,
          uid: true,
        })) {
          const envelope = msg.envelope;
          if (!envelope) continue;

          // Extract body text from source if available
          let body = '';
          if (msg.source) {
            const sourceStr = msg.source.toString();
            // Simple extraction — grab text after blank line (header/body separator)
            const bodyStart = sourceStr.indexOf('\r\n\r\n');
            if (bodyStart !== -1) {
              body = sourceStr.substring(bodyStart + 4).trim();
            }
          }

          messages.push({
            messageId: envelope.messageId || undefined,
            from: envelope.from?.[0]
              ? `${envelope.from[0].name || ''} <${envelope.from[0].address || ''}>`
              : 'unknown',
            to: (envelope.to || []).map(
              (a: { name?: string; address?: string }) =>
                `${a.name || ''} <${a.address || ''}>`.trim()
            ),
            subject: envelope.subject || '(no subject)',
            body,
            date: envelope.date ? new Date(envelope.date).toISOString() : new Date().toISOString(),
            inReplyTo: envelope.inReplyTo || undefined,
          });
        }

        // Sort by date ascending
        messages.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

        const participants = [
          ...new Set(messages.flatMap((m) => [m.from, ...m.to])),
        ];

        return {
          threadId,
          subject: messages[0]?.subject || '(no subject)',
          participants,
          messages,
          messageCount: messages.length,
        };
      } finally {
        lock.release();
      }
    } catch (error) {
      log.error('IMAP thread fetch failed', { error: (error as Error).message });
      throw error;
    } finally {
      await client.logout().catch(() => {});
    }
  }

  // ── Helpers ─────────────────────────────────────────────────

  private createImapClient(): ImapFlow {
    return new ImapFlow({
      host: this.config.imapHost,
      port: this.config.imapPort,
      secure: true,
      auth: {
        user: this.config.user,
        pass: this.config.pass,
      },
      logger: false, // Silence imapflow's built-in logging
    });
  }
}
