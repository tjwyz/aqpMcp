import axios, { AxiosResponse } from 'axios';

interface RequestOptions {
  url: string;
  token: string | null;
}

interface PostRequestOptions extends RequestOptions {
  body: any;
}

export interface SearchContextItem {
  displayName: string;
  parameter: string;
  isPostBody: boolean;
  value: string;
}

interface FetchParamsInput {
  token: string | null;
}

interface SearchContextResponse {
  contextGroups: {
    searchContextGroupList: SearchContextItem[];
  }[];
}

export async function AQPget({ url, token }: RequestOptions): Promise<AxiosResponse<any>> {
  return axios.get(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
}

export async function AQPpost({
  url,
  body,
  token,
}: PostRequestOptions): Promise<AxiosResponse<any>> {
  return axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
}

export const fetchParams = async ({ token }: FetchParamsInput): Promise<SearchContextItem[]> => {
  const url = 'https://adqueryprobet.trafficmanager.net/api/v1/context/searchcontext?mode=ta';
  const response = await AQPget({ url, token });

  const data = response.data as SearchContextResponse;
  const ret: SearchContextItem[] = [];

  for (const group of data.contextGroups) {
    for (const item of group.searchContextGroupList) {
      ret.push({
        displayName: item.displayName,
        parameter: item.parameter,
        isPostBody: item.isPostBody,
        value: item.value,
      });
    }
  }

  return ret;
};
