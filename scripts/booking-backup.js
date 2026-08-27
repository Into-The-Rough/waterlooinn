"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { backup, DatabaseSync } = require("node:sqlite");

const projectRoot = path.resolve(__dirname, "..");
const databasePath = path.resolve(process.env.BOOKING_DATABASE_PATH ||
    path.join(projectRoot, ".local", "booking-diary.sqlite"));
const backupDirectory = path.resolve(process.env.BOOKING_BACKUP_DIRECTORY ||
    path.join(projectRoot, ".local", "backups"));
const retentionDays = Number(process.env.BOOKING_BACKUP_RETENTION_DAYS || 30);
const encodedKey = String(process.env.BOOKING_BACKUP_KEY || "");
const key = Buffer.from(encodedKey, "base64");

if (key.length !== 32 || key.toString("base64") !== encodedKey) {
    throw new Error("BOOKING_BACKUP_KEY must be a canonical base64-encoded 32-byte key.");
}
if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
    throw new Error("BOOKING_BACKUP_RETENTION_DAYS must be between 1 and 365.");
}
if (!fs.existsSync(databasePath)) throw new Error(`Booking database not found: ${databasePath}`);

async function main() {
    fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
    fs.chmodSync(backupDirectory, 0o700);
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "waterloo-booking-backup-"));
    const plaintextPath = path.join(temporaryDirectory, "snapshot.sqlite");
    let database;
    try {
        database = new DatabaseSync(databasePath, { readOnly: true });
        await backup(database, plaintextPath);
        database.close();
        database = null;

        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
        const encrypted = Buffer.concat([
            cipher.update(fs.readFileSync(plaintextPath)),
            cipher.final()
        ]);
        const tag = cipher.getAuthTag();
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const destination = path.join(backupDirectory, `booking-diary-${timestamp}.sqlite.aes256gcm`);
        fs.writeFileSync(destination, Buffer.concat([
            Buffer.from("WIBK1", "ascii"), iv, tag, encrypted
        ]), { mode: 0o600, flag: "wx" });
        fs.chmodSync(destination, 0o600);

        const cutoff = Date.now() - (retentionDays * 86400000);
        for (const entry of fs.readdirSync(backupDirectory, { withFileTypes: true })) {
            if (!entry.isFile() || !/^booking-diary-.*\.sqlite\.aes256gcm$/.test(entry.name)) continue;
            const candidate = path.join(backupDirectory, entry.name);
            if (fs.statSync(candidate).mtimeMs < cutoff) fs.unlinkSync(candidate);
        }
        console.log(`Encrypted booking backup created: ${destination}`);
    } finally {
        if (database) database.close();
        if (fs.existsSync(plaintextPath)) fs.unlinkSync(plaintextPath);
        if (fs.existsSync(temporaryDirectory)) fs.rmdirSync(temporaryDirectory);
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
