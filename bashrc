
export EDITOR=vim

# History lengt
export HISTSIZE=1000
export HISTFILESIZE=2000

# Colors
alias ls='ls --color=auto'
alias grep='grep --color=auto'
alias tree='tree -C'

# ddp -> dd progress. dd prints the current speed and progress.
alias ddp='kill -USR1 `pgrep ^dd`'

# Perl -pie regular expression substitution, with backup.
alias pie='perl -pi.bak -e'

# Fast reboot
alias reboot='shutdown -r now'

# Fast poweroff
alias poweroff='shutdown -h now'

# Vim aliases
alias v='vim'
alias g='gvim'

# Terminal colors
# As seen in http://vim.wikia.com/wiki/256_colors_in_vim
if [ "$TERM" = "xterm" ] ; then
    if [ -z "$COLORTERM" ] ; then
        if [ -z "$XTERM_VERSION" ] ; then
            echo "Warning: Terminal wrongly calling itself 'xterm'."
        else
            case "$XTERM_VERSION" in
            "XTerm(278)") TERM="xterm-256color" ;;
            "XTerm(256)") TERM="xterm-256color" ;;
            "XTerm(88)") TERM="xterm-88color" ;;
            "XTerm") ;;
            *)
                echo "Warning: Unrecognized XTERM_VERSION: $XTERM_VERSION"
                ;;
            esac
        fi
    else
        case "$COLORTERM" in
            gnome-terminal)
                TERM="gnome-256color" ;;
            *)
                echo "Warning: Unrecognized COLORTERM: $COLORTERM" ;;
        esac
    fi
fi

