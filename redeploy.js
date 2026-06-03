const https = require('https');

const token = '9V6_uuMOUUz_bE-5ovcv-Ensa4ocZLy0ddVzrHCu3T_';
const environmentId = 'af3f70b2-0f57-4d62-951e-259ddb03731e';
const serviceId = '6d0f8234-ccc2-4961-9266-c573e8b8a6fd';

const query = {
  query: `mutation { serviceInstanceRedeploy(environmentId: "${environmentId}", serviceId: "${serviceId}") }`
};

const body = JSON.stringify(query);

const options = {
  hostname: 'backboard.railway.app',
  path: '/graphql/v2',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    'Content-Length': Buffer.byteLength(body)
  }
};

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    console.log('Response:', data);
    const parsed = JSON.parse(data);
    if (parsed.errors) {
      console.error('GraphQL errors:', JSON.stringify(parsed.errors, null, 2));
    } else {
      console.log('Redeploy triggered successfully');
    }
  });
});

req.on('error', (e) => console.error('Request error:', e.message));
req.write(body);
req.end();
