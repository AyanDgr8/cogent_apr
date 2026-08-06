import { pool } from './database/config.js';

const startTimestamp = 1776643200; // 20/04/2026 12:00 AM IST
const endTimestamp = 1776729540;   // 20/04/2026 11:59 PM IST
const agentExt = '1448';

console.log('🔍 Checking extension:', agentExt);
console.log('📅 Time range:', new Date(startTimestamp * 1000).toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'}), 'to', new Date(endTimestamp * 1000).toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'}));

try {
  // First identify the agent name from extension
  const [nameRows] = await pool.execute(`
    SELECT DISTINCT agent_name FROM agent_activity
    WHERE JSON_UNQUOTE(JSON_EXTRACT(raw_data, '$.ext')) = ?
    LIMIT 5
  `, [agentExt]);
  console.log('\n👤 Agent name(s) for ext', agentExt, ':', nameRows.map(r => r.agent_name));

  // Get ALL agent_reg events (login/logout) for the full day
  const [regEvents] = await pool.execute(`
    SELECT event_timestamp, agent_name, raw_data
    FROM agent_activity
    WHERE JSON_UNQUOTE(JSON_EXTRACT(raw_data, '$.ext')) = ?
      AND event_type = 'agent_reg'
      AND event_timestamp >= ?
      AND event_timestamp <= ?
    ORDER BY event_timestamp
  `, [agentExt, startTimestamp, endTimestamp]);

  console.log('\n🔐 agent_reg (LOGIN/LOGOUT) events for full day:', regEvents.length);
  if (regEvents.length === 0) {
    console.log('  ❌ NO login or logout events found for this agent on this day!');
  } else {
    regEvents.forEach((event, idx) => {
      const ts = new Date(event.event_timestamp * 1000).toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'});
      try {
        const data = JSON.parse(event.raw_data);
        const action = data.enabled ? '🔐 LOGIN ' : '🚪 LOGOUT';
        console.log(`  ${idx + 1}. ${action} | ${ts} (${event.event_timestamp})`);
      } catch (e) {}
    });
  }

  // Get all events for the day (summarized by type)
  const [allEvents] = await pool.execute(`
    SELECT event_type, COUNT(*) as count,
      MIN(event_timestamp) as first_ts,
      MAX(event_timestamp) as last_ts
    FROM agent_activity
    WHERE JSON_UNQUOTE(JSON_EXTRACT(raw_data, '$.ext')) = ?
      AND event_timestamp >= ?
      AND event_timestamp <= ?
    GROUP BY event_type
    ORDER BY first_ts
  `, [agentExt, startTimestamp, endTimestamp]);

  console.log('\n📊 Event summary for the full day:');
  if (allEvents.length === 0) {
    console.log('  ❌ NO events at all for this agent on this day!');
  } else {
    allEvents.forEach(row => {
      const first = new Date(row.first_ts * 1000).toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'});
      const last = new Date(row.last_ts * 1000).toLocaleString('en-IN', {timeZone: 'Asia/Kolkata'});
      console.log(`  - ${row.event_type}: ${row.count} events | First: ${first} | Last: ${last}`);
    });
  }

  // Check hourly slots stored in agent_complete_hourly
  const [slotRows] = await pool.execute(`
    SELECT
      time_slot_label, start_time, end_time,
      first_login_time, last_logout_time, login_time, total_calls
    FROM agent_complete_hourly
    WHERE agent_extension = ?
      AND start_time >= ?
      AND end_time <= ?
    ORDER BY start_time
  `, [agentExt, startTimestamp, endTimestamp]);

  console.log('\n� agent_complete_hourly slots for the day:', slotRows.length);
  slotRows.forEach(slot => {
    console.log(`\n  Slot: ${slot.time_slot_label}`);
    console.log(`  First login:  ${slot.first_login_time || 'NULL'}`);
    console.log(`  Last logout:  ${slot.last_logout_time || 'NULL'}`);
    console.log(`  Login time:   ${slot.login_time}`);
    console.log(`  Total calls:  ${slot.total_calls}`);
  });

} catch (error) {
  console.error('❌ Error:', error.message);
  console.error(error);
} finally {
  await pool.end();
}
