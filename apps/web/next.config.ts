import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // The API is a separate service. Everything the browser needs goes through
  // server components and server actions, so no API URL is ever exposed to the
  // client and no token leaves the server.
};

export default config;
