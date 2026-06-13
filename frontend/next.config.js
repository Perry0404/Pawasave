/** @type {import('next').NextConfig} */
const nextConfig = {
  // FIND-INFRA-01: don't advertise the framework/version.
  poweredByHeader: false,
  reactStrictMode: true,
  compress: true,
};

module.exports = nextConfig;