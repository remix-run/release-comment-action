import { Octokit } from "@octokit/action";

export const octokit = new Octokit();

export const graphqlWithAuth = octokit.graphql;

export const gql = String.raw;
