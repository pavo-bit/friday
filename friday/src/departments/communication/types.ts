// ============================================================
// Communication Department — Type Definitions
// Shared types for email, messaging, and translation actions
// ============================================================

import { ActionType } from '../../shared/types';

// ── Task Input ──────────────────────────────────────────────

/** The unified input shape handed to `runCommunicationTask`. */
export interface CommunicationTask {
  action:
    | ActionType.DRAFT_EMAIL
    | ActionType.SEND_EMAIL
    | ActionType.READ_EMAIL
    | ActionType.SUMMARIZE_THREAD
    | ActionType.TRANSLATE_MESSAGE
    | ActionType.SEND_WHATSAPP;
  rawInput: string;

  // Optional extracted params (may be empty if intent parser couldn't extract)
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  /** Contact name for WhatsApp */
  contact?: string;
  /** Pre-composed message for WhatsApp */
  message?: string;
  /** Search / filter query for reading email */
  query?: string;
  /** Target language for translation */
  language?: string;
  /** IMAP folder to read from */
  folder?: string;
  /** Thread / message ID for summarize_thread */
  threadId?: string;
}

// ── Email Primitives ────────────────────────────────────────

/** A single email message. */
export interface EmailMessage {
  messageId?: string;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  /** Plain-text body (if available alongside HTML) */
  textBody?: string;
  date: string;
  /** References header for threading */
  references?: string[];
  inReplyTo?: string;
  attachments?: EmailAttachment[];
}

/** Minimal attachment descriptor. */
export interface EmailAttachment {
  filename: string;
  contentType: string;
  size: number;
}

/** A conversation thread — an ordered array of related messages. */
export interface EmailThread {
  threadId: string;
  subject: string;
  participants: string[];
  messages: EmailMessage[];
  messageCount: number;
}

// ── IMAP Filters ────────────────────────────────────────────

/** Criteria used by `readEmails()` to narrow results. */
export interface EmailFilter {
  /** IMAP folder (default: INBOX) */
  folder?: string;
  /** Only from this sender */
  from?: string;
  /** Only unread messages */
  unreadOnly?: boolean;
  /** Maximum messages to return */
  limit?: number;
  /** Messages since this ISO date */
  since?: string;
  /** Free-text search (IMAP SEARCH body) */
  query?: string;
}

// ── Provider Interface ──────────────────────────────────────

/** Abstract contract that any email backend must implement. */
export interface EmailProviderInterface {
  /** Send an email and return the message ID. */
  sendEmail(msg: Pick<EmailMessage, 'to' | 'cc' | 'bcc' | 'subject' | 'body'>): Promise<string>;

  /** Read emails matching the given filter. */
  readEmails(filter: EmailFilter): Promise<EmailMessage[]>;

  /** Fetch a full thread by message / thread ID. */
  getThread(threadId: string): Promise<EmailThread | null>;
}

// ── SMTP / IMAP Config ──────────────────────────────────────

/** Configuration required by `SmtpImapProvider`. */
export interface SmtpImapConfig {
  smtpHost: string;
  smtpPort: number;
  imapHost: string;
  imapPort: number;
  user: string;
  pass: string;
  fromAddress: string;
}
