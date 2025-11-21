/**
 * GQty AUTO-GENERATED CODE: PLEASE DO NOT MODIFY MANUALLY
 */

import { type ScalarsEnumsHash } from 'gqty';

export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
export type Exact<T extends { [key: string]: unknown }> = {
  [K in keyof T]: T[K];
};
export type MakeOptional<T, K extends keyof T> = Omit<T, K> & {
  [SubKey in K]?: Maybe<T[SubKey]>;
};
export type MakeMaybe<T, K extends keyof T> = Omit<T, K> & {
  [SubKey in K]: Maybe<T[SubKey]>;
};
export type MakeEmpty<
  T extends { [key: string]: unknown },
  K extends keyof T
> = { [_ in K]?: never };
export type Incremental<T> =
  | T
  | {
      [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never;
    };
/** All built-in and custom scalars, mapped to their actual values */
export interface Scalars {
  ID: { input: string; output: string };
  String: { input: string; output: string };
  Boolean: { input: boolean; output: boolean };
  Int: { input: number; output: number };
  Float: { input: number; output: number };
  /** Custom scalar that handles both integers and floats */
  Number: { input: number; output: number };
  Any: { input: any; output: any };
  /** Represents NULL values */
  Void: { input: any; output: any };
  /** The `JSONObject` scalar type represents JSON objects as specified by [ECMA-404](http://www.ecma-international.org/publications/files/ECMA-ST/ECMA-404.pdf). */
  JSONObject: { input: any; output: any };
  File: { input: any; output: any };
  /** A date-time string at UTC, such as 2007-12-03T10:15:30Z, compliant with the `date-time` format outlined in section 5.6 of the RFC 3339 profile of the ISO 8601 standard for representation of dates and times using the Gregorian calendar.This scalar is serialized to a string in ISO 8601 format and parsed from a string in ISO 8601 format. */
  DateTimeISO: { input: any; output: any };
  /** The `JSON` scalar type represents JSON values as specified by [ECMA-404](http://www.ecma-international.org/publications/files/ECMA-ST/ECMA-404.pdf). */
  JSON: { input: any; output: any };
}

export interface ValuesInput {
  emailAddress: Scalars['String']['input'];
  username: Scalars['String']['input'];
  password?: InputMaybe<Scalars['String']['input']>;
  hashedPassword?: InputMaybe<Scalars['String']['input']>;
  details?: InputMaybe<DetailsInput>;
}

export interface DetailsInput {
  firstName?: InputMaybe<Scalars['String']['input']>;
  lastName?: InputMaybe<Scalars['String']['input']>;
}

export const scalarsEnumsHash: ScalarsEnumsHash = {
  Any: true,
  Boolean: true,
  DateTimeISO: true,
  File: true,
  JSON: true,
  JSONObject: true,
  Number: true,
  String: true,
  Void: true,
};
export const generatedSchema = {
  Details: {
    __typename: { __type: 'String!' },
    sequence: { __type: 'String!' },
    creationDate: { __type: 'String!' },
    changeDate: { __type: 'String!' },
    resourceOwner: { __type: 'String!' },
  },
  DetailsInput: {
    firstName: { __type: 'String' },
    lastName: { __type: 'String' },
  },
  Details_1: {
    __typename: { __type: 'String!' },
    sequence: { __type: 'String!' },
    creationDate: { __type: 'String!' },
    resourceOwner: { __type: 'String!' },
  },
  Email: { __typename: { __type: 'String!' }, email: { __type: 'String' } },
  HumanUser: {
    __typename: { __type: 'String!' },
    profile: { __type: 'Profile' },
    email: { __type: 'Email' },
    phone: { __type: 'JSONObject' },
  },
  Profile: {
    __typename: { __type: 'String!' },
    firstName: { __type: 'String' },
    lastName: { __type: 'String' },
    displayName: { __type: 'String' },
    preferredLanguage: { __type: 'String' },
  },
  UserCreateResponse: {
    __typename: { __type: 'String!' },
    userId: { __type: 'String!' },
    details: { __type: 'Details_1!' },
  },
  ValuesInput: {
    emailAddress: { __type: 'String!' },
    username: { __type: 'String!' },
    password: { __type: 'String' },
    hashedPassword: { __type: 'String' },
    details: { __type: 'DetailsInput' },
  },
  ZitadelUser: {
    __typename: { __type: 'String!' },
    id: { __type: 'String!' },
    details: { __type: 'Details!' },
    state: { __type: 'String!' },
    userName: { __type: 'String!' },
    loginNames: { __type: '[String!]!' },
    preferredLoginName: { __type: 'String!' },
    human: { __type: 'HumanUser' },
  },
  mutation: {
    __typename: { __type: 'String!' },
    userCreate: {
      __type: 'UserCreateResponse!',
      __args: {
        values: 'ValuesInput!',
        organizationId: 'String',
        createProfile: 'Boolean',
        skipEmailVerification: 'Boolean',
      },
    },
  },
  query: {
    __typename: { __type: 'String!' },
    user: { __type: 'String!' },
    getIsUnique: { __type: 'Boolean', __args: { loginName: 'String!' } },
    getUserCount: { __type: 'Number!' },
    getAllUser: { __type: '[ZitadelUser!]!', __args: { limit: 'Number' } },
  },
  subscription: {},
} as const;

export interface Details {
  __typename?: 'Details';
  sequence: ScalarsEnums['String'];
  creationDate: ScalarsEnums['String'];
  changeDate: ScalarsEnums['String'];
  resourceOwner: ScalarsEnums['String'];
}

export interface Details_1 {
  __typename?: 'Details_1';
  sequence: ScalarsEnums['String'];
  creationDate: ScalarsEnums['String'];
  resourceOwner: ScalarsEnums['String'];
}

export interface Email {
  __typename?: 'Email';
  email?: Maybe<ScalarsEnums['String']>;
}

/**
 * Contains human-specific attributes (profile, email, phone).
 */
export interface HumanUser {
  __typename?: 'HumanUser';
  profile?: Maybe<Profile>;
  email?: Maybe<Email>;
  phone?: Maybe<ScalarsEnums['JSONObject']>;
}

export interface Profile {
  __typename?: 'Profile';
  firstName?: Maybe<ScalarsEnums['String']>;
  lastName?: Maybe<ScalarsEnums['String']>;
  displayName?: Maybe<ScalarsEnums['String']>;
  preferredLanguage?: Maybe<ScalarsEnums['String']>;
}

export interface UserCreateResponse {
  __typename?: 'UserCreateResponse';
  userId: ScalarsEnums['String'];
  details: Details_1;
}

export interface ZitadelUser {
  __typename?: 'ZitadelUser';
  id: ScalarsEnums['String'];
  details: Details;
  state: ScalarsEnums['String'];
  userName: ScalarsEnums['String'];
  loginNames: Array<ScalarsEnums['String']>;
  preferredLoginName: ScalarsEnums['String'];
  human?: Maybe<HumanUser>;
}

export interface Mutation {
  __typename?: 'Mutation';
  userCreate: (args: {
    values: ValuesInput;
    organizationId?: Maybe<ScalarsEnums['String']>;
    createProfile?: Maybe<ScalarsEnums['Boolean']>;
    skipEmailVerification?: Maybe<ScalarsEnums['Boolean']>;
  }) => UserCreateResponse;
}

export interface Query {
  __typename?: 'Query';
  user: ScalarsEnums['String'];
  getIsUnique: (args: {
    loginName: ScalarsEnums['String'];
  }) => Maybe<ScalarsEnums['Boolean']>;
  getUserCount: ScalarsEnums['Number'];
  getAllUser: (args?: {
    limit?: Maybe<ScalarsEnums['Number']>;
  }) => Array<ZitadelUser>;
}

export interface Subscription {
  __typename?: 'Subscription';
}

export interface GeneratedSchema {
  query: Query;
  mutation: Mutation;
  subscription: Subscription;
}

export type ScalarsEnums = {
  [Key in keyof Scalars]: Scalars[Key] extends { output: unknown }
    ? Scalars[Key]['output']
    : never;
} & {};

/**
 * Contains code for parameter to argument conversion.
 */

export interface MutationTypes {
  userCreate: {
    params: [
      values: ValuesInput,
      organizationId?: Maybe<ScalarsEnums['String']>,
      createProfile?: Maybe<ScalarsEnums['Boolean']>,
      skipEmailVerification?: Maybe<ScalarsEnums['Boolean']>
    ];
    return: UserCreateResponse;
  };
}

export interface QueryTypes {
  getIsUnique: {
    params: [loginName: ScalarsEnums['String']];
    return: Maybe<ScalarsEnums['Boolean']>;
  };
  getAllUser: {
    params: [limit?: Maybe<ScalarsEnums['Number']>];
    return: Array<ZitadelUser>;
  };
}

export const MutationParamNames = {
  userCreate: [
    'values',
    'organizationId',
    'createProfile',
    'skipEmailVerification',
  ],
};
export const QueryParamNames = {
  getIsUnique: ['loginName'],
  getAllUser: ['limit'],
};

export function convertParamsToArgsFn<T>(
  argNames: string[],
  params: unknown[]
): T {
  const result: Record<string, unknown> = {};

  argNames.forEach((key, index) => {
    const value = params[index];
    // Only set the property if it's not undefined
    if (value !== undefined) {
      result[key] = value;
    }
  });

  return result as T;
}

export const convertParamsToArgs = {
  Mutation: {
    userCreate(
      params: MutationTypes['userCreate']['params']
    ): Parameters<Mutation['userCreate']>[0] {
      return convertParamsToArgsFn<Parameters<Mutation['userCreate']>[0]>(
        MutationParamNames['userCreate'],
        params
      );
    },
  },
  Query: {
    getIsUnique(
      params: QueryTypes['getIsUnique']['params']
    ): Parameters<Query['getIsUnique']>[0] {
      return convertParamsToArgsFn<Parameters<Query['getIsUnique']>[0]>(
        QueryParamNames['getIsUnique'],
        params
      );
    },
    getAllUser(
      params: QueryTypes['getAllUser']['params']
    ): Parameters<Query['getAllUser']>[0] {
      return convertParamsToArgsFn<Parameters<Query['getAllUser']>[0]>(
        QueryParamNames['getAllUser'],
        params
      );
    },
  },
};
