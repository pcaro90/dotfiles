vim.bo.textwidth = 88 -- Black standard
vim.wo.colorcolumn = "+1"

local fname = vim.uri_to_fname(vim.uri_from_bufnr(0))
local venv_path = nil

-- Try to find a venv or .venv folder
local venv = vim.fs.find({ "venv", ".venv" }, { upward = true, path = fname })
if venv and #venv > 0 then
  venv_path = venv[1]
end

-- Not found, try to find a poetry.lock
local poetry_lock = vim.fs.find("poetry.lock", { upward = true, path = fname })
if poetry_lock and #poetry_lock > 0 then
  venv_path = vim.fn.trim(vim.fn.system("poetry env info -p"))
end

-- Set the virtual environment for the current buffer
if venv_path then
  vim.env.VIRTUAL_ENV = venv_path
  vim.env.PATH = venv_path .. "/bin:" .. vim.env.PATH
end
