# Sourced from /usr/local/share/fish/functions/up-or-search.fish with changes
# Depending on cursor position and current mode, either search backward or move up one line"
function __custom_up_or_search -d "Search back or move cursor up 1 line"
    # If we are already in search mode, continue
    if commandline --search-mode
        commandline -f history-prefix-search-backward
        return
    end

    # If we are navigating the pager, then up always navigates
    if commandline --paging-mode
        commandline -f up-line
        return
    end

    # We are not already in search mode.
    # If we are on the top line, start search mode,
    # otherwise move up
    set -l lineno (commandline -L)

    switch $lineno
        case 1
            # Expand abbreviations to search the full command
            commandline -f expand-abbr
            # Delete everything after cursor, keep only text before it
            set -l line (commandline)
            set -l cursor (commandline -C)
            commandline (string sub -l (math $cursor) $line)
            commandline -f history-prefix-search-backward

        case '*'
            commandline -f up-line
    end
end
