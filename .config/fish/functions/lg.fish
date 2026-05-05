function lg --description 'lazygit (yadm repo if outside a git repo)'
    if git rev-parse --is-inside-work-tree &>/dev/null
        lazygit $argv
    else
        lazygit --git-dir="$HOME/.local/share/yadm/repo.git/" --work-tree="$HOME" $argv
    end
end
