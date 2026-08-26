import { service, assertRuntimeConfiguration } from "../lib/booking-runtime.mjs";

export default async function handler() {
    assertRuntimeConfiguration();
    const reminders = await service.sendDueReminders({ actor: "Scheduled maintenance" });
    const retention = await service.runRetention();
    console.log(JSON.stringify({
        event: "booking_maintenance_complete",
        remindersPrepared: reminders.preparedCount,
        retention
    }));
}

export const config = { schedule: "0 */6 * * *" };
