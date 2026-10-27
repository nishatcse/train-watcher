/// Where the monitoring backend lives. Not a secret: the app proves itself with a
/// per-device token it receives when pairing, so nothing sensitive is compiled in.
const String kDefaultBackendUrl = String.fromEnvironment(
  'BACKEND_URL',
  defaultValue: 'https://backend-production-ff8f.up.railway.app',
);

const String kRailwayLoginUrl = 'https://eticket.railway.gov.bd/login';
const String kRailwayHomeUrl = 'https://eticket.railway.gov.bd/';
