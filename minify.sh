#!/bin/bash

# Check if the filename argument is provided
if [ -z "$1" ]; then
  echo "Usage: $0 <filename>"
  exit 1
fi

# Input and Output file paths
INPUT_FILE="$1"
OUTPUT_FILE="${INPUT_FILE%.*}.min.js"

# Check if the input file exists
if [ ! -f "$INPUT_FILE" ]; then
  echo "Error: $INPUT_FILE not found!"
  exit 1
fi

# Minify the JavaScript: Remove comments and unnecessary whitespace
sed '/\/\/.*$/d' "$INPUT_FILE" | sed 's/\/\*.*\*\///g' | \
# Remove unnecessary spaces and line breaks
awk '{
  gsub(/[[:space:]]+/, " ");  # Remove extra spaces
  gsub(/^[[:space:]]+|[[:space:]]+$/, "");  # Trim spaces at the beginning and end of each line
  print
}' | \
# Remove all newlines and minimize the code to a single line
tr -s '\n' ' ' | tr -s ' ' > "$OUTPUT_FILE"

# Check if the minification was successful
if [ $? -eq 0 ]; then
  echo "Successfully minified JavaScript to $OUTPUT_FILE"
else
  echo "Minification failed."
fi
