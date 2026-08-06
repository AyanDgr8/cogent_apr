export const TENANT_CONFIG = {
  hth: {
    name: 'hth',
    base_url: ('hth', 'API_BASE_URL', 'https://uc.cogentlab.com:9443'),
    account_id: ('hth', 'ACCOUNT_ID', '508cebbc46bf3e4d42b80b174c2035c3'),
    api_key: ('hth', 'API_KEY', '671dfbc7f16de08627ff870db50734a164419a6c096a34cb7ec576f9788e69de'),
    domain: 'cogent',
    productive_states: [
      'Manual',
      'Working',
      'On Chat',
      'Training'
    ],
    non_productive_states: [
      'Tea break',
      'Away',
      'Lunch'
    ]
  }
};

export function getTenantConfig(tenant) {
  const key = (tenant || '').toLowerCase();
  const config = TENANT_CONFIG[key];
  if (!config) {
    throw new Error(`Unknown tenant "${tenant}". Available tenants: ${Object.keys(TENANT_CONFIG).join(', ')}`);
  }
  return config;
}

export function getAllTenants() {
  return Object.keys(TENANT_CONFIG);
}

export function isProductiveState(tenant, stateName) {
  const config = getTenantConfig(tenant);
  return config.productive_states.includes(stateName);
}

export function isNonProductiveState(tenant, stateName) {
  const config = getTenantConfig(tenant);
  return config.non_productive_states.includes(stateName);
}

// Auto-detect if a state is a break based on keywords
function isBreakState(stateName) {
  const breakKeywords = ['break', 'lunch', 'tea', 'bio', 'meal', 'rest'];
  const lowerState = (stateName || '').toLowerCase();
  return breakKeywords.some(keyword => lowerState.includes(keyword));
}

export function isProductiveBreak(tenant, stateName) {
  const config = getTenantConfig(tenant);
  return config.productive_states.includes(stateName) && isBreakState(stateName);
}

export function isNonProductiveBreak(tenant, stateName) {
  const config = getTenantConfig(tenant);
  return config.non_productive_states.includes(stateName) && isBreakState(stateName);
}

export function getTenantTableSuffix(tenant) {
  const key = (tenant || '').toLowerCase();
  return key.replace(/[^a-z0-9_]/g, '');
}

export const TENANT_BASE_HEADER = TENANT_CONFIG;
