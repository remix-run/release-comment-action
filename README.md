# release-comment-action

A GitHub Action to automatically comment on Pull Requests and related issues about a release. Used by [Remix][remix] and [React Router][react_router].

## Usage

Basic usage can be enabled simply by using the following.

```yaml
- name: 📝 Comment on related issues and pull requests
  uses: mcansh/release-comment-action@0.2.0
```

This covers a lot of use cases, even this repo uses this set up, however in a monorepo set up you may want to to follow a specific package (like `remix`, or `react-router`). In those situations the following can be used to filter on only the `remix` tag and only commits that affect the `./packages` directory.

```yaml
- name: 📝 Comment on related issues and pull requests
  uses: mcansh/release-comment-action@0.2.0
  with:
    DIRECTORY_TO_CHECK: "./packages"
    PACKAGE_VERSION_TO_FOLLOW: "remix"
```

### Options

| Option                    | Required | Default                  |
| ------------------------- | -------- | ------------------------ |
| GH_TOKEN                  | n        | ${{ github.token }}      |
| GITHUB_REPOSITORY         | n        | ${{ github.repository }} |
| DIRECTORY_TO_CHECK        | n        | ./                       |
| PACKAGE_VERSION_TO_FOLLOW | n        |                          |

[remix]: https://github.com/remix-run/remix
[react_router]: https://github.com/remix-run/react-router
