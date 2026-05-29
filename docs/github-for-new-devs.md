# GitHub for New Developers

This guide shows the basic GitHub workflow for this project. Use it when you want to save work, share it, or collaborate with another developer.

## Core Ideas

Git tracks file changes on your computer. GitHub stores a copy of the repository online so other people and tools can access it.

- Repository: the project folder and its Git history.
- Commit: a saved checkpoint of changes.
- Branch: a separate line of work.
- Remote: the GitHub copy of the repository, usually named `origin`.
- Pull request: a review page for merging one branch into another.

## First-Time Setup

Install Git, then set your name and email once:

```powershell
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

Sign in to GitHub in your browser. If you use GitHub CLI, install it and run:

```powershell
gh auth login
```

## Daily Workflow

Check what changed:

```powershell
git status
```

Review the exact edits:

```powershell
git diff
```

Stage files you want to save:

```powershell
git add manifest.json review/review.js
```

Commit the staged changes:

```powershell
git commit -m "Describe the change"
```

Push the branch to GitHub:

```powershell
git push
```

## Starting a New Feature

Create a branch before editing:

```powershell
git switch -c feature/short-description
```

Make your changes, test them, commit them, then push:

```powershell
git push -u origin feature/short-description
```

Open a pull request on GitHub to compare your branch with `master`.

## Getting Updates

Before starting new work, update your local branch:

```powershell
git switch master
git pull
```

If you are working on a feature branch and want the latest `master` changes:

```powershell
git switch feature/short-description
git merge master
```

## Good Commit Habits

Keep commits focused. A commit should represent one understandable change, such as "Add review reminder notification" or "Fix vocabulary image fallback".

Use `git status` before every commit. Do not commit generated files, secrets, local logs, build output, or dependency folders.

## Common Fixes

Unstage a file without deleting edits:

```powershell
git restore --staged path/to/file
```

Discard edits in one file:

```powershell
git restore path/to/file
```

See recent commits:

```powershell
git log --oneline -5
```

Check the GitHub remote:

```powershell
git remote -v
```

Add a GitHub remote after creating an empty repository on GitHub:

```powershell
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
git push -u origin master
```

## Project-Specific Notes

This project is a Chrome extension named GermanyVocab. Keep browser verification output, local screenshots, logs, API keys, and environment files out of Git. Source files such as `manifest.json`, `background/`, `content/`, `popup/`, `options/`, `review/`, `pdf-viewer/`, `assets/`, and `docs/` are the normal files to commit.
