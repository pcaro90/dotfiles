if not status is-interactive
    return 0
end

###################################################################################
# Basic configuration

# Disable autosuggestions
set -g fish_autosuggestion_enabled 0

# Disable greeting
set -U fish_greeting

# Set Vi mode
fish_vi_key_bindings

# Expand abbreviations before prefix-history search with arrow keys
bind up __custom_up_or_search
bind -M insert up __custom_up_or_search

# PATH additions (only if they exist)
for dir in ~/bin ~/.local/bin ~/go/bin ~/.nimble/bin ~/.zvm/bin ~/.local/share/pnpm
    if test -d "$dir"
        fish_add_path $dir
    end
end

# Tools
fzf --fish | source
atuin init fish --disable-up-arrow | source
starship init fish | source
zoxide init fish | source

###################################################################################
# Abbreviations

# Faster movement to parent paths
abbr -a parent_jump --regex '\.\.+' --function _parent_jump

# Better ls
abbr -a l -- eza
abbr -a ls -- eza
abbr -a la -- eza -la

# Frequently used applications
abbr -a v -- nvim
abbr -a d -- docker
abbr -a j -- just
abbr -a py -- python
abbr -a t -- task
abbr -a s -c '' -c proxychains -- ssh
abbr -a pc -- proxychains -q
abbr -a psg -- 'ps aux | rg'

# Git super-abbr
abbr -a git --regex 'g.*' --set-cursor --function _git
