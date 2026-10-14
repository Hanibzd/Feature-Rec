/** Render-time stand-in for next/navigation: a static route, navigation is a no-op. */
const noop = () => undefined;
export function useRouter() {
  return { push: noop, replace: noop, refresh: noop, back: noop, forward: noop, prefetch: noop };
}
export const usePathname = () => "/";
export const useSearchParams = () => new URLSearchParams();
export const useParams = () => ({});
export const useSelectedLayoutSegment = () => null;
export const useSelectedLayoutSegments = () => [];
export const redirect = noop;
export const notFound = noop;
