import { httpClient } from '../../../shared/lib/httpClient';

export interface SearchResult {
  type: 'CHILD' | 'DEVICE' | 'NOTIFICATION';
  id: string;
  title: string;
  subtitle: string;
}

export const searchApi = {
  search(query: string): Promise<SearchResult[]> {
    return httpClient<SearchResult[]>(`/search?q=${encodeURIComponent(query)}`);
  },
};
