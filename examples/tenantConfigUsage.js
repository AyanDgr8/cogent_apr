import { 
  getTenantConfig, 
  getAllTenants, 
  isProductiveState, 
  isNonProductiveState,
  isProductiveBreak,
  isNonProductiveBreak,
  getTenantTableSuffix 
} from '../tenantConfig.js';

console.log('=== Tenant Configuration Usage Examples ===\n');

console.log('1. Get all available tenants:');
const tenants = getAllTenants();
console.log('   Available tenants:', tenants);
console.log('');

console.log('2. Get configuration for a specific tenant:');
const thrivecoConfig = getTenantConfig('thriveco');
console.log('   Thriveco config:', {
  name: thrivecoConfig.name,
  domain: thrivecoConfig.domain,
  base_url: thrivecoConfig.base_url
});
console.log('');

console.log('3. Check if a state is productive:');
console.log('   Is "On Call" productive for Thriveco?', isProductiveState('thriveco', 'On Call'));
console.log('   Is "Idle" productive for Thriveco?', isProductiveState('thriveco', 'Idle'));
console.log('');

console.log('4. Check if a state is non-productive:');
console.log('   Is "Not Available" non-productive for Hero?', isNonProductiveState('hero', 'Not Available'));
console.log('   Is "Wrap Up" non-productive for Hero?', isNonProductiveState('hero', 'Wrap Up'));
console.log('');

console.log('5. Check productive breaks:');
console.log('   Is "Lunch Break" a productive break for Amity?', isProductiveBreak('amity', 'Lunch Break'));
console.log('   Is "Training" a productive break for Amity?', isProductiveBreak('amity', 'Training'));
console.log('');

console.log('6. Check non-productive breaks:');
console.log('   Is "Training" a non-productive break for Thriveco?', isNonProductiveBreak('thriveco', 'Training'));
console.log('   Is "Tea Break" a non-productive break for Thriveco?', isNonProductiveBreak('thriveco', 'Tea Break'));
console.log('');

console.log('7. Get database table suffix:');
console.log('   Table suffix for Thriveco:', getTenantTableSuffix('thriveco'));
console.log('   Example table name: final_report_' + getTenantTableSuffix('thriveco'));
console.log('');

console.log('8. Calculate productive time for an agent:');
const agentStates = [
  { state: 'On Call', duration: 3600 },      // 1 hour
  { state: 'Wrap Up', duration: 600 },       // 10 minutes
  { state: 'Lunch Break', duration: 1800 },  // 30 minutes
  { state: 'Idle', duration: 900 },          // 15 minutes
  { state: 'Training', duration: 1200 }      // 20 minutes
];

const tenant = 'thriveco';
let productiveTime = 0;
let nonProductiveTime = 0;
let productiveBreakTime = 0;
let nonProductiveBreakTime = 0;

agentStates.forEach(({ state, duration }) => {
  if (isProductiveBreak(tenant, state)) {
    productiveBreakTime += duration;
  } else if (isNonProductiveBreak(tenant, state)) {
    nonProductiveBreakTime += duration;
  } else if (isProductiveState(tenant, state)) {
    productiveTime += duration;
  } else if (isNonProductiveState(tenant, state)) {
    nonProductiveTime += duration;
  }
});

console.log('   Agent Time Breakdown:');
console.log('   - Productive Time:', productiveTime, 'seconds (' + (productiveTime / 60) + ' minutes)');
console.log('   - Non-Productive Time:', nonProductiveTime, 'seconds (' + (nonProductiveTime / 60) + ' minutes)');
console.log('   - Productive Break Time:', productiveBreakTime, 'seconds (' + (productiveBreakTime / 60) + ' minutes)');
console.log('   - Non-Productive Break Time:', nonProductiveBreakTime, 'seconds (' + (nonProductiveBreakTime / 60) + ' minutes)');
console.log('   - Total Time:', (productiveTime + nonProductiveTime + productiveBreakTime + nonProductiveBreakTime), 'seconds');
console.log('');

console.log('9. Iterate through all tenants and their productive states:');
tenants.forEach(tenant => {
  const config = getTenantConfig(tenant);
  console.log(`   ${config.name}:`);
  console.log(`     - Productive states: ${config.productive_states.join(', ')}`);
  console.log(`     - Non-productive states: ${config.non_productive_states.join(', ')}`);
});
console.log('');

console.log('10. Error handling example:');
try {
  getTenantConfig('nonexistent');
} catch (error) {
  console.log('   Caught error:', error.message);
}
