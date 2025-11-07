/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import Cloudflare from 'cloudflare';

export interface Env {
    API_TOKEN: string;
    ACCOUNT_ID: string;
    ZONE_ID: string;
}

const CLIENT = new Cloudflare({
    // @ts-ignore
    apiToken: process.env.API_TOKEN,
});

type Devices = {
    [id: string]: Device
};

type Device = {
    name: string;
    updated: Date;
    ip: string | null;
}

type Records = {
    [id: string]: Record
}

type Record = {
    name: string;
    content: string;
}

export default {
    async scheduled(controller: ScheduledController,
                    env: Env,
                    ctx: ExecutionContext) {

        // Make sure we have all relevant environment variables set
        if (env.ACCOUNT_ID === undefined || env.ZONE_ID === undefined || env.API_TOKEN === undefined) {
            console.log("ACCOUNT_ID, ZONE_ID and API_TOKEN must be set");
            return;
        }

        // Get zone name
        const zone_name = await get_zone_name(env.ZONE_ID);
        console.log(`Updating ${zone_name}`);

        // Get list of devices
        const devices = await get_devices(env.ACCOUNT_ID);
        console.log(`Found ${Object.keys(devices).length} devices`);

        // Find corresponding WARP CGNAT IPs
        for (const id in devices) {
            const ip = await get_ip(env.ACCOUNT_ID, id, env.API_TOKEN);

            if (ip === null) {
                continue;
            }

            devices[id].ip = ip;
            console.log(`${devices[id].name} has IP address ${ip}`);
        }

        // Get a list of DNS Records
        const records = await get_dns_records(env.ZONE_ID);
        console.log(`Found ${Object.keys(records).length} existing DNS records`);

        // Update Internal DNS Zone
        await update_dns_records(env.ZONE_ID, zone_name, records, devices);
    }
} satisfies ExportedHandler<Env>;

// Returns a list of Zero Trust devices
async function get_devices(account_id: string): Promise<Devices> {
    let devices: Devices = {}

    for await (const device of CLIENT.zeroTrust.devices.devices.list(
        {account_id},
    )) {
        let id = device.id;
        let name = device.name;
        let updated = new Date(device.updated_at);
        let existing = Object.values(devices).filter(device => device.name === name);

        if (existing.length === 0 || existing[0].updated < updated) {
            devices[id] = {
                name,
                updated,
                ip: null
            }
        }
    }

    return devices
}

// Returns a WARP's CGNAT IP
async function get_ip(account_id: string, device_id: string, api_token: string): Promise<string | null> {
    let response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account_id}/warp/${device_id}`, {
        headers: {
            'authorization': `Bearer ${api_token}`
        }
    })

    if (response.status !== 200) {
        return null;
    }

    try {
        let json: any = await response.json();

        if (json.success !== true) {
            return null;
        }

        return json.result.metadata.ipv4;
    } catch (ex) {
        console.log(`${device_id} has empty metadata block`);
        return null;
    }
}

// Returns a zone's name from a given zone ID
async function get_zone_name(zone_id: string): Promise<string> {
    const zone = await CLIENT.zones.get({zone_id});

    return zone.name
}

// Returns a list of all DNS records from a given zone ID
async function get_dns_records(zone_id: string): Promise<Records> {
    let records: Records = {}

    for await (const record of CLIENT.dns.records.list(
        {zone_id, type: "A"},
    )) {
        let id = record.id;
        let name = record.name;
        let content = record.content ?? '';

        records[id] = {name, content}
    }

    return records
}

// Iterates a list of devices and calls the update function on each of them
async function update_dns_records(zone_id: string, zone_name: string, records: Records, devices: Devices) {
    for (const id in devices) {
        await update_dns_record(zone_id, zone_name, records, devices[id]);
    }
}

// Updates or creates DNS records for a given device
async function update_dns_record(zone_id: string, zone_name: string, records: Records, device: Device) {
    // DNS Record TTL defaults to 5 minutes
    const ttl = 300;

    // Make sure IP address is a valid IPv4
    const content = device.ip ?? '';
    if (!isIPv4(content)) {
        return;
    }

    // Make sure DNS record names are always lowercase
    const name = [device.name.toLowerCase(), zone_name].join('.');

    // Check if record for device exists
    const entries = Object.entries(records).filter(([id, record]) => record.name === name);
    const exists = entries.length > 0;

    let updated = false;

    // If it exists, update all dns records. Otherwise, creates a new record
    if (exists) {
        let id = entries[0][0];
        let record = entries[0][1];

        if (record.content !== content) {
            await CLIENT.dns.records.update(id, {name, type: "A", zone_id, content, ttl});
            updated = true;
        }

    } else {
        await CLIENT.dns.records.create({name, type: "A", zone_id, content, ttl})
    }

    console.log(`DNS Record for ${name} ${(exists) ? ((updated) ? 'updated' : 'untouched') : 'created'}`)
}

// Returns true if given string is a valid IPv4 address
function isIPv4(str: string): boolean {
    const parts = str.split(".");
    if (parts.length !== 4) return false;

    return parts.every((part) => {
        if (!/^\d+$/.test(part)) return false;
        const num = Number(part);
        return num >= 0 && num <= 255 && String(num) === part;
    });
}
