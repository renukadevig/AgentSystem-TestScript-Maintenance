/** @type {import('next').NextConfig} */
const nextConfig = {
  // Cypress and the git/child_process work must run in Node, never get bundled
  // by the server compiler. Keeping these external avoids webpack trying to
  // statically analyze Cypress's CommonJS internals.
  serverExternalPackages: ["cypress"],
};

export default nextConfig;
