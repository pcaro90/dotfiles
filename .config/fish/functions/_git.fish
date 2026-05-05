function _git -d "Super-abbr function to git/yadm"
    switch $argv[1]
        case g
            set cmd
        case gs
            set cmd status
        case gl
            set cmd log
        case ga
            set cmd add
        case gd
            set cmd diff
        case gds
            set cmd diff --staged
        case gcm
            set cmd commit --message
        case gcl
            set cmd clone
        case gco
            set cmd checkout
        case gpl
            set cmd pull
        case gps
            set cmd push
        case gr
            set cmd remote -v
        case '*'
            return 1
    end

    if git rev-parse --is-inside-work-tree &>/dev/null ; or test "$cmd" = "clone"
        set client git
    else
        set client yadm
    end

    echo $client $cmd $argv[2..-1]
end
