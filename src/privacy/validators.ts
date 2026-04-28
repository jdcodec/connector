export function luhn(input: string): boolean {
  const digits = input.replace(/\D/g, "");
  if (digits.length < 2) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

export function abaMod10(input: string): boolean {
  const digits = input.replace(/\D/g, "");
  if (digits.length !== 9) return false;
  const weights = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += (digits.charCodeAt(i) - 48) * weights[i];
  }
  return sum % 10 === 0;
}

export function tfnMod11(input: string): boolean {
  const digits = input.replace(/\D/g, "");
  if (digits.length !== 9) return false;
  const weights = [1, 4, 3, 7, 5, 8, 6, 9, 10];
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += (digits.charCodeAt(i) - 48) * weights[i];
  }
  return sum % 11 === 0;
}

/**
 * Australian Company Number (ACN) checksum. Weights 8,7,6,5,4,3,2,1 applied to
 * digits 1-8; complement of sum-mod-10 must equal digit 9. See ASIC Information
 * Sheet 99 for the reference algorithm. Disambiguates 9-digit strings that would
 * otherwise tie with TFN_AU_9 on shape alone.
 */
export function acnChecksum(input: string): boolean {
  const digits = input.replace(/\D/g, "");
  if (digits.length !== 9) return false;
  const weights = [8, 7, 6, 5, 4, 3, 2, 1];
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    sum += (digits.charCodeAt(i) - 48) * weights[i];
  }
  const complement = (10 - (sum % 10)) % 10;
  return complement === digits.charCodeAt(8) - 48;
}

export function runValidator(name: string, value: string): boolean {
  switch (name) {
    case "luhn":
      return luhn(value);
    case "aba_mod10":
      return abaMod10(value);
    case "tfn":
      return tfnMod11(value);
    case "acn":
      return acnChecksum(value);
    default:
      return true;
  }
}

export function hasKnownValidator(name: string): boolean {
  return name === "luhn" || name === "aba_mod10" || name === "tfn" || name === "acn";
}
