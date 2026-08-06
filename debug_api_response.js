import fetch from 'node-fetch';

const agentExt = '1448';
const startDate = 1776643200; // 20/04/2026 12:00 AM
const endDate = 1776729540;   // 20/04/2026 11:59 PM

console.log('🔍 Debugging API response for extension:', agentExt);

try {
  const response = await fetch(`http://localhost:9501/api/unified-apr-report?start=${startDate}&end=${endDate}&agent_extension=${agentExt}`);
  const data = await response.json();
  
  console.log('\n📊 Total records:', data.count);
  
  // Show first record with activity
  const recordWithActivity = data.data.find(row => 
    row.login_time !== '00:00:00' || row.total_calls > 0
  );
  
  if (recordWithActivity) {
    console.log('\n🔍 Sample record with activity:');
    console.log('Time slot:', recordWithActivity.time_slot_label);
    console.log('Agent:', recordWithActivity.agent_name);
    console.log('Login time:', recordWithActivity.login_time);
    console.log('Total calls:', recordWithActivity.total_calls);
    console.log('has_logout_in_slot:', recordWithActivity.has_logout_in_slot);
    console.log('last_event_time:', recordWithActivity.last_event_time);
    console.log('last_logout_time:', recordWithActivity.last_logout_time);
    console.log('first_login_time:', recordWithActivity.first_login_time);
  }
  
  // Show all records
  console.log('\n📋 All records:');
  data.data.forEach(row => {
    if (row.login_time !== '00:00:00' || row.total_calls > 0) {
      console.log(`\n${row.time_slot_label}`);
      console.log(`  login_time: ${row.login_time}`);
      console.log(`  total_calls: ${row.total_calls}`);
      console.log(`  has_logout_in_slot: ${row.has_logout_in_slot}`);
      console.log(`  last_event_time: ${row.last_event_time || 'NULL'}`);
    }
  });
  
} catch (error) {
  console.error('❌ Error:', error.message);
}
