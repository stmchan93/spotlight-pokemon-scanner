import { SearchSurface } from '@/features/catalog/search-surface';

/** Search as the /catalog/search sheet (the Search tab renders `mode="tab"`). */
export default function ExpansionBrowserRoute() {
  return <SearchSurface mode="sheet" />;
}
