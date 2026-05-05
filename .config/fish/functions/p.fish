function p -d "Ping with alert"
    set -l target $argv[1] 8.8.8.8
    ping -a $target[1]
end
