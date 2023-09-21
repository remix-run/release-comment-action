// first mark the test as dry run so we don't interact with the GitHub API
// TODO: look into adding msw to mock the API calls
process.env.INPUT_DRY_RUN = "TRUE";
