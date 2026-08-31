-- Store original receiving mailbox for reply-hop From
ALTER TABLE reply_routes ADD COLUMN our_mailbox TEXT;
