# Teideal delivery board

A local, Jira-style board for the Teideal backlog: 19 epics, 108 user stories and 793 tests.

## Run it

Double-click `index.html` to open it in Chrome, Edge, Firefox or Safari. It needs no server, no install and no internet connection.

If your browser restricts local files, serve the folder instead:

```
python3 -m http.server 8000
```

Then open http://localhost:8000.

## How stories move

- Ticking a criterion or recording a test result moves a story from **To Do** to **In Progress**.
- When every criterion is ticked and every test has passed, the story moves to **Done** automatically.
- If a Done story loses a criterion or a test fails, it moves back to **In Progress**.
- You can drag cards between columns, but a story can only enter Done when it meets that definition of done.

## Your progress

Progress is saved in your browser's local storage for this file. To share progress or move it to another machine, use **Export progress** and **Import progress**. **Reset** returns every story to To Do.

## Notes

- Stories are numbered in implementation order (#1 to #108), and every column is sorted by that number.
- Stories TEID-87 to TEID-127 come from the missing-stories import file. Their keys assume that file is imported next into the TEID project.
- Tests combine one functional test per acceptance criterion with targeted non-functional and adversarial test cases per story, based on that story's risk area (security, performance, data integrity, etc).
