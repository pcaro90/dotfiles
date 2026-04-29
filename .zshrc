#***************************************************************************************
# Basic configuration

# Neovim as system editor
export EDITOR=nvim

# Force a widely supported TERM for reliable SSH/tmux behavior
export TERM=xterm-256color

# History options
HISTSIZE=999999999
SAVEHIST=999999999
HISTFILE=~/.zhistory
setopt HIST_IGNORE_DUPS        # Don't save duplicate consecutive commands
setopt HIST_IGNORE_SPACE       # Don't save commands starting with a space
setopt EXTENDED_HISTORY        # Save timestamps and duration for each command
setopt INC_APPEND_HISTORY_TIME # Write to history immediately, with timestamps

# PATH additions (only if they exist)
for dir in ~/bin ~/.local/bin ~/go/bin ~/.nimble/bin ~/.zvm/bin ~/.local/share/pnpm; do
    [[ -d $dir ]] && path+=($dir)
done

# Tools
eval "$(starship init zsh)"
eval "$(atuin init zsh --disable-up-arrow)"
eval "$(zoxide init zsh)"
eval "$(fzf --zsh)"
export RIPGREP_CONFIG_PATH="$HOME/.config/ripgrep/config"

#***************************************************************************************
# Aliases

# Faster movement to parent paths
alias ..='cd ..'
alias ...='cd ../..'
alias ....='cd ../../..'

# Better ls
alias l='eza'
alias ls='eza'
alias la='eza -la'

# Frequently used applications
alias v='nvim'
alias g='git'
alias d='docker'
alias lg='lazygit'
alias j='just'
alias py='python'
alias s='ssh'
alias t='task'

# Public IP
alias iip='curl https://icanhazip.com'

# Grep IP (rg)
alias gip='rg --pcre2 "(?<![\.\d])(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(?![\.\d])"'

# Ping with alert
p() { ping -a ${1:-8.8.8.8}; }

# Smart base64 decoding
b64() {
    if [[ -n $1 ]]; then
        [[ -f $1 ]] && base64 -d <"$1" || printf '%s' "$1" | base64 -d
    else
        base64 -d
    fi
}

#***************************************************************************************
# Keyboard and keybindings

# Vim mode
bindkey -v
bindkey -M viins '^?' backward-delete-char # Allow backspace before insertion point

# Key timing — low enough for responsiveness, high enough to parse key sequences
# KEYTIMEOUT: time to wait for multi-char escape sequences (e.g. arrow keys)
# ESCDELAY: time to decide if ESC is a vim mode switch or part of a key sequence
export KEYTIMEOUT=10
export ESCDELAY=5

# Special key bindings for both insert (viins) and normal (vicmd) modes
# Bind all common sequences: CSI (foot), SS3 (terminfo), and tmux fallbacks
# Foot sends CSI sequences (\e[A), while terminfo for xterm-256color expects SS3 (\eOA).
# We bind both so everything work in foot, tmux, and over SSH.
for mode in viins vicmd; do
    # Arrow keys — substring search in insert, plain history in normal
    bindkey -M $mode '\e[A' history-beginning-search-backward # Up (CSI)
    bindkey -M $mode '\e[B' history-beginning-search-forward  # Down (CSI)
    bindkey -M $mode '\eOA' history-beginning-search-backward # Up (SS3)
    bindkey -M $mode '\eOB' history-beginning-search-forward  # Down (SS3)

    # Navigation
    bindkey -M $mode '\e[H' beginning-of-line  # Home (CSI)
    bindkey -M $mode '\e[F' end-of-line        # End (CSI)
    bindkey -M $mode '\eOH' beginning-of-line  # Home (SS3)
    bindkey -M $mode '\eOF' end-of-line        # End (SS3)
    bindkey -M $mode '\e[1~' beginning-of-line # Home (tmux fallback)
    bindkey -M $mode '\e[4~' end-of-line       # End (tmux fallback)

    # Delete / Page
    bindkey -M $mode '\e[3~' delete-char  # Delete
    bindkey -M $mode '\e[5~' up-history   # Page Up
    bindkey -M $mode '\e[6~' down-history # Page Down
done

#***************************************************************************************
# Completion system
autoload -Uz compinit && compinit -i -d "${XDG_CACHE_HOME:-$HOME/.cache}/zsh/.zcompdump" 

setopt COMPLETE_IN_WORD     # Complete from both ends of a word
setopt ALWAYS_TO_END        # Move cursor to end of completed word
setopt PATH_DIRS            # Path search even on command names with slashes
setopt AUTO_MENU            # Show completion menu on successive Tab
setopt AUTO_LIST            # List choices on ambiguous completion
setopt AUTO_PARAM_SLASH     # Trailing slash on completed directories
unsetopt MENU_COMPLETE      # Don't autoselect first entry
unsetopt FLOW_CONTROL       # Free Ctrl+S / Ctrl+Q for other uses

# Cache completion results (speeds up apt, docker, etc.)
zstyle ':completion::complete:*' use-cache on
zstyle ':completion::complete:*' cache-path "${XDG_CACHE_HOME:-$HOME/.cache}/zsh"

# Case-insensitive, partial-word, and substring matching
zstyle ':completion:*' matcher-list \
 'm:{[:lower:]}={[:upper:]}' 'm:{[:upper:]}={[:lower:]}' 'r:|[._-]=* r:|=*' \
 'l:|=* r:|=*'

# Group matches, describe, colorize
zstyle ':completion:*:*:*:*:*' menu select
zstyle ':completion:*:matches' group 'yes'
zstyle ':completion:*:default' list-colors ${(s.:.)LS_COLORS}
zstyle ':completion:*:options' description 'yes'
zstyle ':completion:*:options' auto-description '%d'
zstyle ':completion:*:corrections' format ' %F{green}-- %d (errors: %e) --%f'
zstyle ':completion:*:descriptions' format ' %F{yellow}-- %d --%f'
zstyle ':completion:*:messages' format ' %F{purple} -- %d --%f'
zstyle ':completion:*:warnings' format ' %F{red}-- no matches found --%f'
zstyle ':completion:*:default' list-prompt '%S%M matches%s'
zstyle ':completion:*' format ' %F{yellow}-- %d --%f'
zstyle ':completion:*' group-name ''
zstyle ':completion:*' verbose yes

# Fuzzy match mistyped completions (1 error, scaling up to 7 for long words)
zstyle ':completion:*' completer _complete _match _approximate
zstyle ':completion:*:match:*' original only
zstyle ':completion:*:approximate:*' max-errors 1 numeric
zstyle -e ':completion:*:approximate:*' max-errors \
 'reply=($((($#PREFIX+$#SUFFIX)/3>7?7:($#PREFIX+$#SUFFIX)/3))numeric)'

# Hide internal functions from completion
zstyle ':completion:*:functions' ignored-patterns '(_*|pre(cmd|exec))'

# Array completion element sorting
zstyle ':completion:*:*:-subscript-:*' tag-order indexes parameters

# Directories — colorized, squeeze extra slashes
zstyle ':completion:*' squeeze-slashes true
zstyle ':completion:*:*:cd:*' tag-order local-directories directory-stack path-directories
zstyle ':completion:*:*:cd:*:directory-stack' menu yes select
zstyle ':completion:*:-tilde-:*' group-order 'named-directories' 'path-directories' 'users' 'expand'

# History words completion
zstyle ':completion:*:history-words' stop yes
zstyle ':completion:*:history-words' remove-all-dups yes
zstyle ':completion:*:history-words' list false
zstyle ':completion:*:history-words' menu yes

# Environment variables
zstyle ':completion::*:(-command-|export):*' fake-parameters ${${${_comps[(I)-value-*]#*,}%%,*}:#-*-}

# Host completion for ssh/scp/rsync — reads known_hosts, /etc/hosts, ~/.ssh/config
zstyle -e ':completion:*:hosts' hosts 'reply=(
 ${=${=${=${${(f)"$(cat {/etc/ssh_,~/.ssh/known_}hosts(|2)(N) 2>/dev/null)"}%%[#| ]*}//\]:[0-9]*/ }//,/ }//\[/ }
 ${=${(f)"$(cat /etc/hosts(|)(N) <<(ypcat hosts 2>/dev/null))"}%%\#*}
 ${=${${${${(@M)${(f)"$(cat ~/.ssh/config 2>/dev/null)"}:#Host *}#Host }:#*\**}:#*\?*}}
)'

# Filter system users (don't show apache, nobody, sshd, etc.)
zstyle ':completion:*:*:*:users' ignored-patterns \
 adm amanda apache avahi beaglidx bin cacti canna clamav daemon \
 dbus distcache dovecot fax ftp games gdm gkrellmd gopher \
 hacluster haldaemon halt hsqldb ident junkbust ldap lp mail \
 mailman mailnull mldonkey mysql nagios \
 named netdump news nfsnobody nobody nscd ntp nut nx openvpn \
 operator pcap postfix postgres privoxy pulse pvm quagga radvd \
 rpc rpcuser rpm shutdown squid sshd sync uucp vcsa xfs '_*'
zstyle '*' single-ignored show

# rm / kill / diff — allow all files for rm, show your processes for kill
zstyle ':completion:*:(rm|kill|diff):*' ignore-line other
zstyle ':completion:*:rm:*' file-patterns '*:all-files'
zstyle ':completion:*:*:*:*:processes' command 'ps -u $LOGNAME -o pid,user,command -w'
zstyle ':completion:*:*:kill:*:processes' list-colors '=(#b) #([0-9]#) ([0-9a-z-]#)*=01;36=0=01'
zstyle ':completion:*:*:kill:*' menu yes select
zstyle ':completion:*:*:kill:*' force-list always
zstyle ':completion:*:*:kill:*' insert-ids single

# Man pages
zstyle ':completion:*:manuals' separate-sections true
zstyle ':completion:*:manuals.(^1*)' insert-sections true

# SSH/SCP/RSYNC — tag ordering, filtering loopback/localhost/private IPs
zstyle ':completion:*:(ssh|scp|rsync):*' tag-order 'hosts:-host:host hosts:-domain:domain hosts:-ipaddr:ip\ address *'
zstyle ':completion:*:(scp|rsync):*' group-order users files all-files hosts-domain hosts-host hosts-ipaddr
zstyle ':completion:*:ssh:*' group-order users hosts-domain hosts-host users hosts-ipaddr
zstyle ':completion:*:(ssh|scp|rsync):*:hosts-host' ignored-patterns '*(.|:)*' loopback ip6-loopback localhost ip6-localhost broadcasthost
zstyle ':completion:*:(ssh|scp|rsync):*:hosts-domain' ignored-patterns '<->.<->.<->.<->' '^[-[:alnum:]]##(.[-[:alnum:]]##)##' '*@*'
zstyle ':completion:*:(ssh|scp|rsync):*:hosts-ipaddr' ignored-patterns '^(<->.<->.<->.<->|(|::)([[:xdigit:].]##:(#c,2))##(|%*))' '127.0.0.<->' '255.255.255.255' '::1' 'fe80::*'
