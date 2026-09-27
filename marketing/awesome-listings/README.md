# Awesome-list submissions

Drafts of submissions to community awesome-lists. Both content is ready
to ship; the *how* and *when* differ per list.

## awesome-selfhosted

**Status: blocked until first tagged release is 4 months old.**

The maintainers' rule (per the
[addition template](https://github.com/awesome-selfhosted/awesome-selfhosted-data/blob/master/.github/ISSUE_TEMPLATE/addition.md))
is: "Any software project you are adding was first released more than
4 months ago." letmepost has no tagged release yet, so a PR will be
auto-closed with this canned reply:

> Currently, this project has a release, but it is not yet 4 months
> old. (...) Once the first release is four months old, feel free to
> resubmit it to awesome-selfhosted, or you can create an issue instead
> (we don't close issues; we just tag them to indicate they need to
> mature).

**Recommended path:**

1. After cutting the v1 tag on this repo, open an *issue* (not a PR) on
   awesome-selfhosted-data using the
   [Addition template](https://github.com/awesome-selfhosted/awesome-selfhosted-data/issues/new?template=addition.md).
   Paste the contents of `awesome-selfhosted.letmepost.yml` into the
   yaml block.
2. The issue sits there until v1 is 4 months old.
3. At that point convert to a PR by creating
   `software/letmepost-dev.yml` on a fork with the same content.

The maintainer auto-job fills in `stargazers_count`, `updated_at`,
`current_release`, and `commit_history`, so they are omitted from the
draft.

## awesome-oss-alternatives

**Status: ready to submit. No age requirement.**

1. Fork [RunaCapital/awesome-oss-alternatives](https://github.com/RunaCapital/awesome-oss-alternatives).
2. Edit `README.md` and paste the row from
   `awesome-oss-alternatives.row.md` into the "Social Media" section.
   Keep the rows in alphabetical order — letmepost goes before Postiz.
3. Commit on a branch (one startup per PR, per their rules).
4. Open the PR. Title: `Add letmepost.dev`.
