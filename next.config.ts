// import type { NextConfig } from "next";

// const nextConfig: NextConfig = {
//   /* config options here */
// };

// export default nextConfig;
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  webpack: (config, { isServer }) => {
    // Stellar SDK için Node.js polyfills
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        crypto: false,
        stream: false,
        url: false,
        zlib: false,
        http: false,
        https: false,
        assert: false,
        os: false,
        path: false,
      };
    }

    // Critical dependency uyarılarını bastır
    config.externals = config.externals || [];
    if (isServer) {
      config.externals.push({
        '@stellar/stellar-sdk': '@stellar/stellar-sdk'
      });
    }

    return config;
  },
  // TypeScript build hatalarını görmezden gel (sadece geliştirme için)
  typescript: {
    ignoreBuildErrors: process.env.NODE_ENV === 'development',
  },
  // ESLint hatalarını görmezden gel (sadece geliştirme için)
  eslint: {
    ignoreDuringBuilds: process.env.NODE_ENV === 'development',
  },
};

export default nextConfig;