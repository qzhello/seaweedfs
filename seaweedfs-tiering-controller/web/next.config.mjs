/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: "/api/v1/:path*",
        destination: `${process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8081"}/api/v1/:path*`,
      },
    ];
  },
};
export default nextConfig;
