/** Render-time stand-in for next/router (pages router): a static route, navigation is a no-op. */
const resolved = () => Promise.resolve(true);
const router = {
  pathname: "/",
  asPath: "/",
  route: "/",
  query: {},
  isReady: true,
  push: resolved,
  replace: resolved,
  prefetch: () => Promise.resolve(),
  back: () => undefined,
  reload: () => undefined,
  events: { on: () => undefined, off: () => undefined, emit: () => undefined },
};
export const useRouter = () => router;
export default router;
